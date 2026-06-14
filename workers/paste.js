/* global Bare */
// Paste — Pear-end worker for the pear-runtime + Electron path.
//
// Spawned by electron/main.js via PearRuntime.run('/workers/paste.js', [dir,…])
// (a Bare child process — corestore / hyperswarm / sodium-native all run here,
// exactly like backend/desktop-worker.mjs does on the legacy pear-electron
// path). The ONLY differences from desktop-worker.mjs are the transport and
// lifecycle plumbing:
//   wire      pear-pipe (Pear.worker)  ->  FramedStream(Bare.IPC)
//   storage   Pear.config.storage      ->  <Bare.argv[2]>/store
//   teardown  Pear.teardown            ->  graceful-goodbye
// The wire protocol is BYTE-IDENTICAL (newline-JSON, one message per frame):
//   renderer -> worker : { id, command, params } | { type:'visibility', … }
//   worker  -> renderer: { id, ok, result|error } | { type:'event', … }
// so backend/desktop-bridge.js + backend/desktop-worker-protocol.js are reused
// verbatim and test/e2e exercises the same contract.
//
// The updater (/workers/main.js) keeps its own corestore under
// <dir>/pear-runtime/ — never this vault store at <dir>/store.

import goodbye from 'graceful-goodbye'
import FramedStream from 'framed-stream'
import path from 'bare-path'
import { createPearEnd } from '../backend/index.js'
import { createBridge } from '../backend/desktop-bridge.js'
import { attachDesktopWorkerPipe } from '../backend/desktop-worker-protocol.js'

function log (level, msg, extra) {
  // stderr of a PearRuntime.run child is relayed to the renderer console by
  // electron/main.js (pear:worker:stderr:…).
  console.error(JSON.stringify({ t: Date.now(), level, msg, ...(extra || {}) }))
}

const wire = new FramedStream(Bare.IPC)
const dir = Bare.argv[2]

if (!dir) {
  log('error', 'paste-worker-no-storage-dir', { hint: 'must be spawned by electron/main.js with [dir,…] args' })
} else {
  const storagePath = path.join(dir, 'store')

  log('info', 'desktop-worker-boot', { storagePath, host: 'pear-runtime' })

  const pearEnd = await createPearEnd({ storagePath })
  const bridge = createBridge(pearEnd)
  bridge.setVisibilityTimeoutMs(60000) // spec §9.4 default convenience timeout

  // worker -> renderer: push backend events (locked/unlocked/clip-captured/…)
  bridge.onMessage((m) => {
    try { wire.write(JSON.stringify(m) + '\n') } catch (_) {}
  })

  // renderer -> worker: newline-delimited JSON requests + lifecycle messages
  attachDesktopWorkerPipe({ wire, bridge, log })

  goodbye(async () => { try { await pearEnd.close() } catch (_) {} })

  log('info', 'desktop-worker-ready')
}
