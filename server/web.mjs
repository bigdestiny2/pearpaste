import http from 'node:http'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPearEnd } from '../backend/index.js'
import { createBridge } from '../backend/desktop-bridge.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.PEARPASTE_HOST || '127.0.0.1'
const port = readPort(process.env.PEARPASTE_PORT || 3000)
const storagePath = process.env.PEARPASTE_STORAGE ||
  path.join(os.homedir() || os.tmpdir(), '.pearpaste-web', 'store')
const maxBodyBytes = 1024 * 1024
const shutdownGraceMs = Number(process.env.PEARPASTE_SHUTDOWN_GRACE_MS || 25000)
const httpCloseMs = Math.min(5000, Math.max(1000, shutdownGraceMs))

await fs.mkdir(storagePath, { recursive: true })

const pearEnd = await createPearEnd({ storagePath, registerGoodbye: false })
const bridge = createBridge(pearEnd)
bridge.setVisibilityTimeoutMs(Number(process.env.PEARPASTE_VISIBILITY_MS || 60000))

const clients = new Set()
const sockets = new Set()
bridge.onMessage((message) => {
  const frame = 'data: ' + JSON.stringify(message) + '\n\n'
  for (const client of clients) {
    try { client.write(frame) } catch (_) {}
  }
})

let seq = 0

const server = http.createServer(async (req, res) => {
  try {
    const url = parseRequestUrl(req.url)
    if (!url) return sendJson(res, 400, { ok: false, error: { message: 'bad request url', code: 'BAD_URL' } })
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, shutdownStarted ? 503 : 200, { ok: !shutdownStarted })
    if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res)
    if (req.method === 'POST' && url.pathname === '/rpc') return handleRpc(req, res)
    if (req.method === 'POST' && url.pathname === '/visibility') return handleVisibility(req, res)
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res)
    return sendJson(res, 405, { ok: false, error: { message: 'method not allowed', code: 'METHOD_NOT_ALLOWED' } })
  } catch (err) {
    const statusCode = httpStatusForError(err)
    return sendJson(res, statusCode, {
      ok: false,
      error: { message: String((err && err.message) || err), code: err && err.code }
    })
  }
})

server.requestTimeout = Number(process.env.PEARPASTE_REQUEST_TIMEOUT_MS || 120000)
server.headersTimeout = Number(process.env.PEARPASTE_HEADERS_TIMEOUT_MS || 15000)
server.keepAliveTimeout = Number(process.env.PEARPASTE_KEEPALIVE_TIMEOUT_MS || 5000)

let shutdownStarted = false

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

server.on('error', (err) => {
  console.error(JSON.stringify({ t: Date.now(), level: 'error', msg: 'web-server-error', err: String(err && err.stack ? err.stack : err) }))
  process.exit(1)
})

server.listen(port, host, () => {
  const addr = server.address()
  const actualPort = addr && typeof addr === 'object' ? addr.port : port
  console.error(JSON.stringify({ t: Date.now(), level: 'info', msg: 'web-server-ready', host, port: actualPort, storagePath }))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  // process.on, not process.once: a second signal during graceful shutdown
  // (e.g. re-raised by a library) must not fall through to the default
  // handler and kill the drain; shutdown() ignores re-entry itself.
  process.on(signal, () => {
    shutdown(signal).catch((err) => {
      console.error(JSON.stringify({ t: Date.now(), level: 'error', msg: 'web-server-shutdown-failed', err: String(err && err.stack ? err.stack : err) }))
      process.exit(1)
    })
  })
}

async function handleRpc (req, res) {
  if (shutdownStarted) return sendJson(res, 503, { ok: false, error: { message: 'server is shutting down', code: 'SHUTTING_DOWN' } })
  const body = await readJsonBody(req)
  const id = body && Object.hasOwn(body, 'id') ? body.id : ++seq
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.command !== 'string') {
    return sendJson(res, 400, { id, ok: false, error: { message: 'command is required', code: 'BAD_REQUEST' } })
  }
  const response = await bridge.request({ id, command: body.command, params: body.params || {} })
  if (response.result && response.result._promise) response.result = await response.result._promise
  return sendJson(res, response.ok ? 200 : httpStatusForRpcError(response.error), response)
}

async function handleVisibility (req, res) {
  if (shutdownStarted) return sendJson(res, 503, { ok: false, error: { message: 'server is shutting down', code: 'SHUTTING_DOWN' } })
  const body = await readJsonBody(req)
  bridge.setVisibility(!!(body && body.visible))
  return sendJson(res, 200, { ok: true })
}

function handleEvents (req, res) {
  if (shutdownStarted) {
    res.writeHead(503, commonHeaders({ 'content-type': 'text/event-stream; charset=utf-8' }))
    res.end('data: {"type":"event","event":"backend-shutdown","payload":{}}\n\n')
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff'
  })
  res.write('retry: 1000\n')
  res.write('data: {"type":"event","event":"web-connected","payload":{}}\n\n')
  clients.add(res)
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch (_) {}
  }, 15000)
  if (keepAlive.unref) keepAlive.unref()
  req.on('close', () => {
    clearInterval(keepAlive)
    clients.delete(res)
  })
}

async function serveStatic (req, res) {
  const filePath = resolveStaticPath(req.url)
  if (!filePath) {
    return sendText(res, 404, 'not found', 'text/plain; charset=utf-8')
  }
  let stat
  try { stat = await fs.stat(filePath) } catch (_) { return sendText(res, 404, 'not found', 'text/plain; charset=utf-8') }
  if (!stat.isFile()) return sendText(res, 404, 'not found', 'text/plain; charset=utf-8')
  res.writeHead(200, {
    'content-type': contentType(filePath),
    'cache-control': cacheControl(filePath),
    'x-content-type-options': 'nosniff'
  })
  if (req.method === 'HEAD') return res.end()
  fsSync.createReadStream(filePath).pipe(res)
}

function isAllowedStaticPath (pathname) {
  if (pathname === '/index.html' || pathname === '/favicon.ico') return true
  return pathname.startsWith('/ui/') || pathname.startsWith('/assets/')
}

function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0)
    if (contentLength > maxBodyBytes) {
      const err = new Error('request body too large')
      err.code = 'BODY_TOO_LARGE'
      reject(err)
      req.resume()
      return
    }
    let size = 0
    const chunks = []
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > maxBodyBytes) {
        done = true
        const err = new Error('request body too large')
        err.code = 'BODY_TOO_LARGE'
        reject(err)
        try { req.destroy() } catch (_) {}
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (err) => { if (!done) reject(err) })
    req.on('end', () => {
      if (done) return
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (_) {
        const err = new Error('invalid json')
        err.code = 'BAD_JSON'
        reject(err)
      }
    })
  })
}

function sendJson (res, statusCode, body) {
  res.writeHead(statusCode, commonHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache'
  }))
  res.end(JSON.stringify(body))
}

function sendText (res, statusCode, body, type) {
  res.writeHead(statusCode, commonHeaders({ 'content-type': type }))
  res.end(body)
}

function commonHeaders (headers) {
  return {
    'x-content-type-options': 'nosniff',
    ...headers
  }
}

function contentType (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.ico') return 'image/x-icon'
  if (ext === '.json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function cacheControl (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (filePath.endsWith('index.html') || ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.json') {
    return 'no-cache'
  }
  return 'public, max-age=3600'
}

function parseRequestUrl (url) {
  try { return new URL(url || '/', 'http://pearpaste.local') } catch (_) { return null }
}

function readPort (value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('PEARPASTE_PORT must be an integer from 1 to 65535')
  }
  return n
}

function resolveStaticPath (url) {
  const parsed = parseRequestUrl(url)
  if (!parsed) return null
  let pathname
  try { pathname = decodeURIComponent(parsed.pathname) } catch (_) { return null }
  if (pathname.includes('\0')) return null
  pathname = path.posix.normalize(pathname)
  if (!pathname.startsWith('/')) pathname = '/' + pathname
  if (pathname === '/') pathname = '/index.html'
  if (!isAllowedStaticPath(pathname)) return null
  const rel = pathname.slice(1).split('/').join(path.sep)
  const filePath = path.resolve(rootDir, rel)
  const back = path.relative(rootDir, filePath)
  if (back.startsWith('..') || path.isAbsolute(back)) return null
  return filePath
}

function httpStatusForError (err) {
  if (!err) return 500
  if (err.code === 'BODY_TOO_LARGE') return 413
  if (err.code === 'BAD_JSON' || err.code === 'BAD_URL') return 400
  return 500
}

function httpStatusForRpcError (error) {
  const code = error && error.code
  if (code === 'LOCKED' || code === 'VAULT_LOCKED') return 423
  if (code === 'NOT_READY' || code === 'ENGINE_CLOSING' || code === 'SHUTTING_DOWN') return 503
  if (code === 'BODY_TOO_LARGE') return 413
  return 400
}

function closeHttpServer () {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        else for (const socket of sockets) socket.destroy()
      } catch (_) {}
      finish()
    }, httpCloseMs)
    if (timer.unref) timer.unref()
    for (const client of clients) {
      try {
        client.write('data: {"type":"event","event":"backend-shutdown","payload":{}}\n\n')
        client.end()
      } catch (_) {}
    }
    clients.clear()
    try {
      server.close(finish)
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
    } catch (_) {
      finish()
    }
  })
}

async function withTimeout (promise, timeoutMs, label) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    if (timer.unref) timer.unref()
  })
  const result = await Promise.race([
    Promise.resolve(promise).then(() => ({ timedOut: false }), (err) => ({ timedOut: false, err })),
    timeout
  ])
  if (timer) clearTimeout(timer)
  if (result.err) {
    console.error(JSON.stringify({ t: Date.now(), level: 'warn', msg: label + '-failed', err: String((result.err && result.err.message) || result.err) }))
  } else if (result.timedOut) {
    console.error(JSON.stringify({ t: Date.now(), level: 'warn', msg: label + '-timeout', timeoutMs }))
  }
  return result
}

async function shutdown (signal) {
  if (shutdownStarted) return
  shutdownStarted = true
  console.error(JSON.stringify({ t: Date.now(), level: 'info', msg: 'web-server-shutdown-begin', signal }))
  await closeHttpServer()
  await withTimeout(bridge.close(), shutdownGraceMs, 'bridge-close')
  console.error(JSON.stringify({ t: Date.now(), level: 'info', msg: 'web-server-shutdown-done' }))
  process.exit(0)
}
