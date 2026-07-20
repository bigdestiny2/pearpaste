// Unit: Electron Forge OTA renderer bridge.
//
// Fakes the preload-exposed window.bridge surface so the shared renderer client
// can be tested without launching Electron or staging a real Pear release.

import test from 'brittle'

const PASTE_WORKER = '/workers/paste.js'
const UPDATER_WORKER = '/workers/main.js'

test('Electron bridge client exposes updater status, apply, restart, and RPC isolation', async (t) => {
  const fake = installFakeElectronBridge()
  t.teardown(fake.restore)

  const { createBridgeClient } = await import('../../ui/shared/bridge-client.js?electron-ota=' + Date.now())
  const bridge = createBridgeClient()
  const events = []
  bridge.onEvent((event, payload) => events.push({ event, payload }))

  t.ok(bridge.supportsUpdates, 'Electron transport advertises OTA support')
  t.alike(fake.started(), [PASTE_WORKER, UPDATER_WORKER], 'renderer starts Paste worker and updater worker')

  fake.emitWorkerIPC(UPDATER_WORKER, new TextEncoder().encode('updating'))
  fake.emitWorkerIPC(UPDATER_WORKER, Buffer.from('updated'))
  await tick()

  t.alike(events.slice(0, 2).map(e => e.event), ['ota-updating', 'ota-updated'], 'updater frames become renderer events')

  const relay = await bridge.relayStatus()
  t.ok(relay.available, 'regular JSON-RPC still travels only through the Paste worker')
  t.is(fake.writesFor(UPDATER_WORKER).length, 0, 'RPC calls never write to the updater worker')

  const applied = await bridge.applyUpdate()
  t.alike(applied, { applied: true }, 'applyUpdate resolves with an applied result')
  t.is(fake.applyCalls(), 1, 'applyUpdate invokes the Electron bridge')
  t.ok(events.some(e => e.event === 'ota-applying'), 'apply emits an applying event')
  t.ok(events.some(e => e.event === 'ota-applied'), 'successful apply emits an applied event')

  const restart = await bridge.appAfterUpdate()
  t.alike(restart, { relaunching: true }, 'appAfterUpdate resolves through the Electron bridge')
  t.is(fake.afterUpdateCalls(), 1, 'restart after update invokes the Electron bridge')
})

test('Electron bridge client reports updater failures without hanging', async (t) => {
  const fake = installFakeElectronBridge()
  t.teardown(fake.restore)

  const { createBridgeClient } = await import('../../ui/shared/bridge-client.js?electron-ota-error=' + Date.now())
  const bridge = createBridgeClient()
  const events = []
  bridge.onEvent((event, payload) => events.push({ event, payload }))

  fake.emitWorkerIPC(UPDATER_WORKER, JSON.stringify({
    type: 'pear:updateError',
    message: 'apply failed',
    code: 'E_APPLY'
  }))
  await tick()

  t.alike(events.at(-1), {
    event: 'ota-error',
    payload: { message: 'apply failed', code: 'E_APPLY' }
  }, 'worker error frame becomes an ota-error event')

  const err = new Error('apply rejected')
  err.code = 'E_REJECTED'
  fake.rejectApplyWith(err)

  await t.exception(
    () => bridge.applyUpdate(),
    /apply rejected/,
    'applyUpdate rejects when Electron main rejects'
  )
  t.ok(events.some(e => e.event === 'ota-error' && e.payload.code === 'E_REJECTED'), 'rejected apply emits ota-error')
})

function installFakeElectronBridge () {
  const oldBridge = snapshotGlobal('bridge')
  const oldPearpaste = snapshotGlobal('__pearpaste')
  const oldPearBridgePipe = snapshotGlobal('__pearBridgePipe')
  const oldPear = snapshotGlobal('Pear')

  delete globalThis.__pearpaste
  delete globalThis.__pearBridgePipe
  delete globalThis.Pear

  const ipcListeners = new Map()
  const exitListeners = new Map()
  const writes = new Map()
  const startedSpecs = []
  let applyCount = 0
  let afterUpdateCount = 0
  let applyError = null

  function listenersFor (map, spec) {
    if (!map.has(spec)) map.set(spec, new Set())
    return map.get(spec)
  }

  function emitWorkerIPC (spec, data) {
    for (const listener of ipcListeners.get(spec) || []) listener(data)
  }

  globalThis.bridge = {
    startWorker (specifier) {
      startedSpecs.push(specifier)
      return true
    },
    onWorkerIPC (specifier, listener) {
      listenersFor(ipcListeners, specifier).add(listener)
      return () => listenersFor(ipcListeners, specifier).delete(listener)
    },
    onWorkerExit (specifier, listener) {
      listenersFor(exitListeners, specifier).add(listener)
      return () => listenersFor(exitListeners, specifier).delete(listener)
    },
    onWorkerStderr () {
      return () => {}
    },
    writeWorkerIPC (specifier, data) {
      listenersFor(writes, specifier).add(data)
      if (specifier === PASTE_WORKER) {
        const msg = JSON.parse(String(data).trim())
        const result = msg.command === 'RELAY_STATUS'
          ? { available: true, directPeers: 0 }
          : {}
        queueMicrotask(() => {
          emitWorkerIPC(specifier, new TextEncoder().encode(JSON.stringify({
            id: msg.id,
            ok: true,
            result
          }) + '\n'))
        })
      }
      return true
    },
    async applyUpdate () {
      applyCount++
      if (applyError) throw applyError
      return { applied: true }
    },
    async appAfterUpdate () {
      afterUpdateCount++
      return { relaunching: true }
    }
  }

  return {
    emitWorkerIPC,
    started: () => startedSpecs.slice(),
    writesFor: (specifier) => Array.from(writes.get(specifier) || []),
    applyCalls: () => applyCount,
    afterUpdateCalls: () => afterUpdateCount,
    rejectApplyWith: (err) => { applyError = err },
    restore: () => {
      restoreGlobal('bridge', oldBridge)
      restoreGlobal('__pearpaste', oldPearpaste)
      restoreGlobal('__pearBridgePipe', oldPearBridgePipe)
      restoreGlobal('Pear', oldPear)
    }
  }
}

function snapshotGlobal (name) {
  return Object.hasOwn(globalThis, name)
    ? { present: true, value: globalThis[name] }
    : { present: false, value: undefined }
}

function restoreGlobal (name, snap) {
  if (snap.present) globalThis[name] = snap.value
  else delete globalThis[name]
}

function tick () {
  return new Promise(resolve => setImmediate(resolve))
}
