// Shared test harness for relay integration tests.
//
// The real p2p-hiverelay-client talks to relays two ways: a Hyperswarm/
// Protomux seed protocol, and HTTP for the Atomic Blind Custody endpoints
// (POST /api/custody/intent, GET /api/custody/<id>/status, ...). For
// runnable, hermetic tests we stand up a minimal in-process FAKE RELAY that
// implements the HTTP custody surface, and a captured fake of the client's
// seed path so we can assert exactly what bytes a relay would receive.
//
// Nothing here mocks the encryption layer — payloads are produced by the real
// relay-service code path so the "relay receives only ciphertext" assertion is
// meaningful.

import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import Hyperswarm from 'hyperswarm'
import LifecycleScope from '../../backend/lifecycle-scope.js'
import * as ops from '../../backend/shared-ops.js'

const require = createRequire(import.meta.url)
const createTestnet = require('@hyperswarm/testnet')

// ---- in-process fake HiveRelay (HTTP custody surface) ----------------------

export async function startFakeRelay ({ requireQuorum = 3 } = {}) {
  const received = [] // every request body the relay saw
  const intents = new Map() // intentId -> { intent, replicas }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let parsed = null
      try { parsed = body ? JSON.parse(body) : {} } catch (_) { parsed = { __unparsed: body } }
      received.push({ method: req.method, url: req.url, body: parsed, raw: body })

      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }

      if (req.method === 'POST' && req.url === '/api/custody/intent') {
        const intentId = 'intent-' + (intents.size + 1) + '-' + Date.now()
        // Relay signs and tracks the ciphertext root it was given.
        intents.set(intentId, {
          intent: parsed,
          ciphertextRoot: parsed.ciphertextRoot,
          replicas: requireQuorum, // fake: immediately at quorum
          requiredReplicas: parsed.requiredReplicas || requireQuorum
        })
        return send(200, {
          intentId,
          ciphertextRoot: parsed.ciphertextRoot,
          signature: 'fake-relay-sig',
          accepted: true
        })
      }

      const m = req.url.match(/^\/api\/custody\/([^/]+)\/status$/)
      if (req.method === 'GET' && m) {
        const id = decodeURIComponent(m[1])
        const rec = intents.get(id)
        if (!rec) return send(404, { error: 'not found' })
        return send(200, {
          intentId: id,
          state: 'committed',
          ciphertextRoot: rec.ciphertextRoot, // echoes OUR root — binding check
          replicas: rec.replicas,
          requiredReplicas: rec.requiredReplicas,
          quorum: rec.replicas
        })
      }

      const cm = req.url.match(/^\/api\/custody\/([^/]+)\/(commit|source-retired|non-serving-proof|witness)$/)
      if (req.method === 'POST' && cm) {
        return send(200, { ok: true, intentId: decodeURIComponent(cm[1]), step: cm[2] })
      }

      send(404, { error: 'unhandled ' + req.method + ' ' + req.url })
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = 'http://127.0.0.1:' + port

  return {
    url,
    received,
    intents,
    async close () { await new Promise((resolve) => server.close(resolve)) }
  }
}

// ---- in-process fake HiveRelayClient ---------------------------------------
// Implements exactly the relay-service surface (start / seed /
// publishCustodyIntent / getCustodyStatus / getRelays / on / destroy). The
// custody calls are proxied to a real in-process startFakeRelay() HTTP server
// so the full publishTemporaryCustody -> getCustodyStatus -> quorum path runs
// on real bytes. seed() returns a deterministic acceptance count.
//
// `mode`:
//   'quorum'        seed accepted by N relays; custody reaches quorum.
//   'custody-fail'  seed accepted, but the relay rejects the custody intent
//                   (HTTP 503) so publishTemporaryCustody fails softly and the
//                   clip must stay local (spec §11 quorum-failure path).
export function makeFakeRelayClientFactory ({ relayUrl, mode = 'quorum', seedAcceptances = 5 } = {}) {
  return async function relayClientFactory () {
    const listeners = new Map()
    return {
      on (ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn) },
      async start () { return this },
      async seed (appKeyHex) {
        // Real client returns an array of acceptances; relay-service uses only
        // .length. Never echoes plaintext.
        return Array.from({ length: seedAcceptances }, (_v, i) => ({
          relayPubkey: 'fake-relay-' + i, appKey: appKeyHex
        }))
      },
      getRelays () {
        return Array.from({ length: seedAcceptances }, (_v, i) => ({ pubkey: 'fake-relay-' + i }))
      },
      async publishCustodyIntent (url, intent, opts = {}) {
        if (mode === 'custody-fail') {
          const e = new Error('custody endpoint failed: 503'); e.status = 503; throw e
        }
        return httpJson((url || relayUrl) + '/api/custody/intent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.apiKey ? { Authorization: 'Bearer ' + opts.apiKey } : {})
          },
          body: JSON.stringify(intent || {})
        })
      },
      async getCustodyStatus (url, intentId) {
        return httpJson((url || relayUrl) +
          '/api/custody/' + encodeURIComponent(intentId) + '/status', { method: 'GET' })
      },
      async destroy () { listeners.clear() }
    }
  }
}

function httpJson (urlStr, reqOpts) {
  const u = new URL(urlStr)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: reqOpts.method,
      headers: reqOpts.headers || {}
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = data ? JSON.parse(data) : {} } catch (_) { parsed = { raw: data } }
        if (res.statusCode >= 400) {
          const e = new Error('custody endpoint failed: ' + ((parsed && parsed.error) || res.statusCode))
          e.status = res.statusCode
          return reject(e)
        }
        resolve(parsed)
      })
    })
    req.on('error', reject)
    if (reqOpts.body) req.write(reqOpts.body)
    req.end()
  })
}

// ---- fake ctx (no Pear-end, no real Hyperswarm) ----------------------------
// relay-service only needs: scope, vaultStore.storagePath + .store, swarm,
// dispatcher.register, state, log, on/emit. We give it a real LifecycleScope
// and a real (temp) Corestore so teardown and export-mirroring are exercised
// for real, but a stub swarm so tests don't hit the DHT.
//
// `relayClientFactory`:
//   undefined -> default: force the absent-dependency degrade path
//                (ctx.relayClientFactory = false). The seed/fallback tests
//                assert local-first behavior; without this the installed
//                optionalDependency would construct a real client against the
//                stub swarm and burn ~20s on discovery timeouts.
//   function  -> injected fake client (makeFakeRelayClientFactory) for the
//                custody happy-path / quorum-failure tests.
export async function makeCtx ({ realSwarm = false, relayClientFactory } = {}) {
  const Corestore = (await import('corestore')).default
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearpaste-relay-test-'))
  const store = new Corestore(dir)
  await store.ready()

  let testnet = null
  let realSwarmInstance = null
  if (realSwarm) {
    testnet = await createTestnet(3)
    realSwarmInstance = new Hyperswarm({ bootstrap: testnet.bootstrap })
  }

  const scope = new LifecycleScope('test')
  const listeners = new Map()
  const handlers = new Map()
  const logs = []
  const log = {
    debug: (m, x) => logs.push(['debug', m, x]),
    info: (m, x) => logs.push(['info', m, x]),
    warn: (m, x) => logs.push(['warn', m, x]),
    error: (m, x) => logs.push(['error', m, x])
  }
  const swarm = realSwarmInstance || {
    connections: new Set(),
    on () {},
    join () { return { flushed: async () => {} } },
    leave () {},
    flush: async () => {},
    destroy: async () => {}
  }
  const ctx = {
    scope,
    vaultStore: { storagePath: dir, store },
    swarm,
    // Default: force the absent-dependency degrade path so the local-first
    // tests are hermetic. Pass a factory in for the custody tests.
    relayClientFactory: relayClientFactory === undefined ? false : relayClientFactory,
    state: {},
    log,
    ops,
    dispatcher: {
      register (cmd, fn) { handlers.set(cmd, fn) },
      has (cmd) { return handlers.has(cmd) },
      call (cmd, params) { return handlers.get(cmd)(params || {}) }
    },
    on (ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn) },
    emit (ev, payload) { for (const fn of listeners.get(ev) || []) { try { fn(payload) } catch (_) {} } },
    isUnlocked: () => true
  }

  return {
    ctx,
    dir,
    logs,
    handlers,
    async cleanup () {
      try { await scope.close() } catch (_) {}
      try { if (realSwarmInstance) await realSwarmInstance.destroy() } catch (_) {}
      try { await store.close() } catch (_) {}
      try { if (testnet) await testnet.destroy() } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
    }
  }
}

export function readRelayExports (dir) {
  const exDir = path.join(dir, 'relay-exports')
  if (!fs.existsSync(exDir)) return []
  return fs.readdirSync(exDir).map((f) => ({
    file: f,
    content: fs.readFileSync(path.join(exDir, f), 'utf8')
  }))
}

export const SENTINEL = ops.SENTINEL_PREFIX + 'SECRET_NOTE_BODY'
