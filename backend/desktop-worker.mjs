// Paste desktop Pear-end worker.
//
// Spawned by the renderer via Pear.worker.run('backend/desktop-worker.mjs')
// (pear-run). This is a Bare child process — corestore / hyperswarm /
// sodium-native all run here. It exposes the Pear-end to the renderer over the
// pear-pipe duplex using the SAME newline-JSON protocol as the in-process
// bridge (createBridge), so test/e2e/desktop-vault.test.js exercises the exact
// wire contract.
//
// Wire protocol (both directions, newline-delimited JSON):
//   renderer -> worker : { id, command, params }
//   renderer -> worker : { type:'visibility', visible:boolean }
//   worker  -> renderer: { id, ok, result } | { id, ok:false, error }
//   worker  -> renderer: { type:'event', event, payload }   (backend events)

import pearPipe from 'pear-pipe'
import { createPearEnd } from './index.js'
import { createBridge } from './desktop-bridge.js'
import { attachDesktopWorkerPipe } from './desktop-worker-protocol.js'

function log (level, msg, extra) {
  // stdout/stderr of a pear-run child surfaces in the parent `pear run` output.
  console.error(JSON.stringify({ t: Date.now(), level, msg, ...(extra || {}) }))
}

const wire = pearPipe()

function fallbackStoragePath () {
  const env = (globalThis.process && process.env) || {}
  if (env.PEARPASTE_STORAGE) return env.PEARPASTE_STORAGE
  if (env.XDG_STATE_HOME) return env.XDG_STATE_HOME.replace(/\/$/, '') + '/pearpaste'
  if (env.HOME) return env.HOME.replace(/\/$/, '') + '/.local/state/pearpaste'
  const tmp = (env.TMPDIR || '/tmp').replace(/\/$/, '')
  const user = String(env.USER || env.LOGNAME || 'user').replace(/[^a-z0-9_.-]/gi, '_')
  return tmp + '/pearpaste-' + user + '-desktop-store'
}

if (!wire) {
  log('error', 'desktop-worker-no-parent', { hint: 'must be spawned via Pear.worker.run' })
} else {
  const storagePath =
    (globalThis.Pear && globalThis.Pear.config && globalThis.Pear.config.storage) ||
    fallbackStoragePath()

  log('info', 'desktop-worker-boot', { storagePath })

  const pearEnd = await createPearEnd({ storagePath })
  const bridge = createBridge(pearEnd)
  bridge.setVisibilityTimeoutMs(60000) // spec §9.4 default convenience timeout

  // worker -> renderer: push backend events (locked/unlocked/clip-captured/…)
  bridge.onMessage((m) => {
    try { wire.write(JSON.stringify(m) + '\n') } catch (_) {}
  })

  // renderer -> worker: newline-delimited JSON requests + lifecycle messages
  attachDesktopWorkerPipe({ wire, bridge, log })

  if (globalThis.Pear && typeof globalThis.Pear.teardown === 'function') {
    globalThis.Pear.teardown(async () => { try { await pearEnd.close() } catch (_) {} })
  }

  log('info', 'desktop-worker-ready')
}
