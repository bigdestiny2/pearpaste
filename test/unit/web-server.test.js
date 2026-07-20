// Unit: self-hosted web bridge smoke path.
//
// Covers the packaging entrypoint used by Umbrel/StartOS:
//   - health endpoint comes up on the configured host/port
//   - locked-allowed RPCs work over POST /rpc
//   - static serving rejects normalized path traversal
//   - SIGTERM drains an open SSE browser connection instead of hanging

import test from 'brittle'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-web-' + tag + '-')) }

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function startWebServer ({ storagePath, port }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/web.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PEARPASTE_HOST: '127.0.0.1',
        PEARPASTE_PORT: String(port),
        PEARPASTE_STORAGE: storagePath,
        PEARPASTE_DISABLE_SWARM: '1',
        PEARPASTE_DISABLE_RELAYS: '1',
        PEARPASTE_SHUTDOWN_GRACE_MS: '5000'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let settled = false
    let stderr = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch (_) {}
      reject(new Error('web server did not become ready; stderr=' + stderr.slice(-2000)))
    }, 15000)
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch (_) { continue }
        if (msg.msg === 'web-server-ready') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ child, stderr: () => stderr })
        }
      }
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('web server exited before ready: code=' + code + ' signal=' + signal + ' stderr=' + stderr.slice(-2000)))
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

function request ({ port, method = 'GET', path: reqPath = '/', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function openEvents ({ port }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/events' })
    req.on('response', (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk.toString()
        if (body.includes('web-connected')) resolve({ req, res })
      })
      res.on('error', () => {})
    })
    req.on('error', reject)
    req.end()
  })
}

function waitExit (child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit after signal')), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

test('self-hosted web server serves RPC/static paths and drains SSE on SIGTERM', async (t) => {
  const dir = tmp('smoke')
  const port = await freePort()
  const { child, stderr } = await startWebServer({ storagePath: dir, port })
  let closed = false
  t.teardown(async () => {
    if (!closed) {
      try { child.kill('SIGTERM') } catch (_) {}
      try { await waitExit(child, 5000) } catch (_) { try { child.kill('SIGKILL') } catch (_) {} }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const health = await request({ port, path: '/healthz' })
  t.is(health.statusCode, 200, 'health endpoint is ready')
  t.alike(JSON.parse(health.body), { ok: true }, 'health body is minimal and positive')

  const rpc = await request({
    port,
    method: 'POST',
    path: '/rpc',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'relay-status', command: 'RELAY_STATUS', params: {} })
  })
  t.is(rpc.statusCode, 200, 'locked-allowed RPC succeeds over HTTP bridge')
  const rpcBody = JSON.parse(rpc.body)
  t.is(rpcBody.id, 'relay-status', 'RPC id is preserved')
  t.ok(rpcBody.ok, 'RPC response is ok')

  const vaultStatus = await request({
    port,
    method: 'POST',
    path: '/rpc',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'vault-status', command: 'VAULT_STATUS', params: {} })
  })
  t.is(vaultStatus.statusCode, 200, 'VAULT_STATUS is allowed while locked')
  t.alike(JSON.parse(vaultStatus.body).result, { hasVault: false, locked: true },
    'fresh storage reports no vault so the UI can open on Create')

  const restoreGlobals = installBrowserBridgeGlobals(port)
  t.teardown(restoreGlobals)
  const bridgeMod = await import('../../ui/shared/bridge-client.js?web-smoke=' + Date.now())
  const bridge = bridgeMod.createBridgeClient()
  const bridgeEvents = []
  bridge.onEvent((event, payload) => bridgeEvents.push({ event, payload }))
  await new Promise(resolve => setTimeout(resolve, 5))
  const relayViaClient = await bridge.relayStatus()
  t.ok(relayViaClient, 'browser bridge client calls POST /rpc')
  t.ok(bridgeEvents.some(e => e.event === 'backend-available'), 'browser bridge surfaces EventSource availability')
  bridge.close()
  t.ok(restoreGlobals.eventSources.every((source) => source.closed), 'browser bridge closes EventSource on request')

  const visibility = await request({
    port,
    method: 'POST',
    path: '/visibility',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visible: false })
  })
  t.is(visibility.statusCode, 200, 'visibility endpoint accepts browser foreground/background state')
  t.alike(JSON.parse(visibility.body), { ok: true }, 'visibility endpoint returns ok')

  const traversal = await request({ port, path: '/ui/../package.json' })
  t.is(traversal.statusCode, 404, 'static path traversal is rejected after normalization')

  const events = await openEvents({ port })
  t.ok(events.res, 'SSE event stream connects')

  child.kill('SIGTERM')
  const exit = await waitExit(child, 7000)
  closed = true
  t.is(exit.code, 0, 'SIGTERM exits cleanly even with an open SSE client')
  t.absent(/shutdown-failed/.test(stderr()), 'shutdown did not log a failure')
})

function installBrowserBridgeGlobals (port) {
  const hadLocation = Object.hasOwn(globalThis, 'location')
  const oldLocation = globalThis.location
  const hadEventSource = Object.hasOwn(globalThis, 'EventSource')
  const oldEventSource = globalThis.EventSource
  const oldFetch = globalThis.fetch

  globalThis.location = { protocol: 'http:' }
  globalThis.fetch = (url, opts) => {
    const target = typeof url === 'string' && url.startsWith('/')
      ? 'http://127.0.0.1:' + port + url
      : url
    return oldFetch.call(globalThis, target, opts)
  }
  const eventSources = []
  globalThis.EventSource = class FakeEventSource {
    constructor (url) {
      this.url = url
      this.closed = false
      eventSources.push(this)
      setTimeout(() => {
        if (typeof this.onopen === 'function') this.onopen({})
      }, 0)
    }

    close () { this.closed = true }
  }

  const restore = () => {
    if (hadLocation) globalThis.location = oldLocation
    else delete globalThis.location
    if (hadEventSource) globalThis.EventSource = oldEventSource
    else delete globalThis.EventSource
    globalThis.fetch = oldFetch
  }
  restore.eventSources = eventSources
  return restore
}
