// Paste desktop root entry (Agent 3).
//
// Responsibilities (spec §12, §15, §22):
//   1. Boot the backend Pear-end (createPearEnd) with the correct storage path:
//        - under Pear:  Pear.config.storage
//        - dev/test:    a stable local path under the OS tmp/app dir
//   2. Open the pear-electron UI (Runtime + pear-bridge) and pipe its lifetime.
//   3. Bridge dispatcher.call -> renderer over a single, schema-validated IPC
//      channel. The renderer NEVER imports the backend; it only sends
//      {id, command, params} and receives {id, ok|error, result}.
//   4. Wire OS-clipboard + visibility (background/foreground) so plaintext is
//      cleared on background and the clipboard adapter can sample.
//
// This file is robust if the `Pear` global is absent (plain Node dev/test): it
// still boots the Pear-end and exposes the same bridge object so the e2e tests
// and a non-Pear harness can drive it without a GUI.

import { createPearEnd } from './backend/index.js'
import { createBridge } from './backend/desktop-bridge.js'

const hasPear = typeof globalThis.Pear !== 'undefined'

// ---- storage path ---------------------------------------------------------
function resolveStoragePath () {
  if (hasPear && globalThis.Pear.config && globalThis.Pear.config.storage) {
    return globalThis.Pear.config.storage
  }
  // Dev/test fallback: a stable per-user dir so a relaunch finds the vault.
  const os = require('os')
  const path = require('path')
  const base = process.env.PEARPASTE_STORAGE ||
    path.join(os.homedir() || os.tmpdir(), '.pearpaste-dev', 'store')
  try { require('fs').mkdirSync(base, { recursive: true }) } catch (_) {}
  return base
}

// ---- pear-electron launcher ----------------------------------------------
// Under the Pear runtime, this entry is the LAUNCHER only. It opens the
// pear-electron window (UI assets served by pear-bridge). It does NOT run the
// Pear-end here: the renderer spawns `backend/desktop-worker.mjs` as a Pear
// worker (Pear.worker.run -> pear-pipe) and talks to it over that pipe. This
// avoids the pear-ipc framing of runtime.start()'s pipe — the worker pipe is a
// raw duplex both ends of which are our own newline-JSON code (identical to
// the in-process protocol the tests exercise).
async function startLauncher () {
  let Runtime, Bridge
  try {
    Runtime = (await import('pear-electron')).default
    Bridge = (await import('pear-bridge')).default
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'desktop-ui-unavailable',
      err: String((err && err.message) || err)
    }))
    return { launcher: false }
  }
  const runtime = new Runtime()
  const pearBridge = new Bridge()
  await pearBridge.ready()
  const pipe = runtime.start({ bridge: pearBridge })
  if (globalThis.Pear && typeof globalThis.Pear.teardown === 'function') {
    globalThis.Pear.teardown(() => { try { pipe.end() } catch (_) {} })
  }
  console.error(JSON.stringify({ level: 'info', msg: 'launcher-started' }))
  return { launcher: true, runtime, pipe }
}

// ---- boot -----------------------------------------------------------------
export async function boot () {
  // Under Pear: launcher only; the Pear-end lives in the spawned worker.
  if (hasPear) return startLauncher()

  // Non-Pear (e2e/clipboard tests, dev harness): in-process Pear-end + bridge.
  // This is the path test/e2e/desktop-vault.test.js and the harness drive.
  const storagePath = resolveStoragePath()
  const pearEnd = await createPearEnd({ storagePath })
  const bridge = createBridge(pearEnd)
  bridge.setVisibilityTimeoutMs(60000) // spec §9.4 default convenience timeout
  return { pearEnd, bridge, storagePath }
}

// Auto-boot when run as the Pear/desktop entry. Under test the harness imports
// { boot } / createBridge instead and never triggers this branch.
const isMain = hasPear ||
  (typeof process !== 'undefined' && process.argv && /index\.js$/.test(process.argv[1] || ''))
if (isMain) {
  boot().catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'boot-failed', err: String((err && err.stack) || err) }))
    if (typeof process !== 'undefined') process.exitCode = 1
  })
}

export { createBridge, resolveStoragePath }
export default boot
