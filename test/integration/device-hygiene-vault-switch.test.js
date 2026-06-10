// Integration: vault-scoped storage hygiene on vault replacement
// (DEVICE_HYGIENE_FIXES Fix A2).
//
// All vaults on one install share the per-link Corestore under the FIXED
// autobase/search namespaces. Re-creating (or restoring) a vault therefore used
// to open the NEW vault's Autobase onto the SAME cores the PRIOR vault wrote, so
// the prior vault's device records surfaced as unresolvable `{ sealed: true }`
// rows in the new vault's DEVICE_LIST and the prior cores lingered on disk.
//
// Fix A2: CREATE_VAULT / RESTORE_VAULT detect that the new vaultId differs from
// the stored one and tear down + WIPE the prior vault's replicated cores before
// opening the new base. The namespace is left unchanged, so a vault that is NOT
// replaced keeps its committed writerKey (no breaking migration).
//
// Acceptance (verbatim from the fix doc): create vault A, add a device, create
// vault B on the same install -> DEVICE_LIST for B returns exactly B's genesis
// device; zero { sealed: true } rows; A's cores are gone from disk.
//
// Run: node test/integration/device-hygiene-vault-switch.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'
import b4a from 'b4a'

import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
import * as pairing from '../../backend/pairing.js'
import * as identity from '../../backend/identity.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hygiene-' + tag + '-')) }
const call = (pe, c, p) => pe.call(c, p || {})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeConn extends EventEmitter {
  constructor () { super(); this.writes = [] }
  write (buf) { this.writes.push(b4a.toString(buf)); return true }
  end () {}
}

// Pump the engine until `pred` holds or we time out.
async function pumpUntil (engine, pred, { timeoutMs = 8000, every = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await engine.refresh() } catch (_) {}
    let v = false
    try { v = await pred() } catch (_) { v = false }
    if (v) return true
    await sleep(every)
  }
  return false
}

// Drive a real signed-hello pairing approval so a SECOND device is committed
// into the current vault's device set (exactly the "add a device" of the
// acceptance scenario). Mirrors pairing-phantom.test.js.
async function addPairedDevice (t, pe) {
  const inv = await call(pe, COMMANDS.PAIR_CREATE_INVITE, { ttlMs: 120000 })
  const decoded = pairing.decodeInvite(inv.invite)
  const joiner = identity.createDeviceIdentity({ label: 'phone', platform: 'ios', roles: ['writer', 'reader'] })
  const hello = {
    t: 'pp-pair-hello',
    v: 1,
    invitePubkey: decoded.invitePubkey,
    expiresAt: decoded.expiresAt,
    deviceId: joiner.deviceId,
    label: joiner.label,
    platform: joiner.platform,
    roles: joiner.roles,
    signingPubkey: joiner.signingPubkey,
    boxPubkey: joiner.boxPubkey,
    writerKey: b4a.toString(b4a.alloc(32, 7), 'hex')
  }
  hello.signature = pe.ctx.crypto.signDetached(joiner.signingSecretKey, pairing.helloProofPayload(hello))

  const conn = new FakeConn()
  const approval = new Promise((resolve) => pe.ctx.on('pair-approval-needed', resolve))
  pe.swarm.emit('connection', conn, { topics: [decoded.topic] })
  conn.emit('data', b4a.from(JSON.stringify(hello)))
  const req = await approval
  t.ok(req && req.requestId, 'signed hello produced a pending approval request')
  await call(pe, COMMANDS.PAIR_APPROVE, { requestId: req.requestId })
  t.ok(pe.ctx.sync.devices.has(joiner.deviceId), 'paired device authorized into vault A')
  return joiner
}

test('Fix A2: a new vault on the same install never inherits the prior vault\'s device records', { timeout: 60000 }, async (t) => {
  const dir = tmp('switch')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {}; fs.rmSync(dir, { recursive: true, force: true }) })

  // ---- Vault A + a paired device -----------------------------------------
  const a = await call(pe, COMMANDS.CREATE_VAULT, { label: 'laptop-A', platform: 'macos', passphrase: 'pw-a' })
  await pe.ctx.sync.ready(15000)
  const joiner = await addPairedDevice(t, pe)

  const twoDevices = await pumpUntil(pe.ctx.sync, () => pe.ctx.sync.devices.size >= 2, { timeoutMs: 8000 })
  t.ok(twoDevices, 'vault A committed its genesis + the paired device')
  const listA = await call(pe, COMMANDS.DEVICE_LIST, {})
  t.is(listA.devices.filter((d) => !d.sealed).length, 2, 'DEVICE_LIST(A) shows two resolvable devices')

  // ---- Vault B on the SAME install ---------------------------------------
  const b = await call(pe, COMMANDS.CREATE_VAULT, { label: 'laptop-B', platform: 'macos', passphrase: 'pw-b' })
  t.not(b.vaultId, a.vaultId, 'vault B has a different vaultId')
  await pe.ctx.sync.ready(15000)
  // Let B's genesis self-add linearize into the committed view.
  await pumpUntil(pe.ctx.sync, () => pe.ctx.sync.devices.size >= 1, { timeoutMs: 8000 })

  const listB = await call(pe, COMMANDS.DEVICE_LIST, {})
  const sealed = listB.devices.filter((d) => d.sealed)
  t.is(sealed.length, 0, 'zero { sealed: true } rows leaked from vault A')
  t.is(listB.devices.length, 1, 'DEVICE_LIST(B) returns exactly one device')
  t.is(listB.devices[0].deviceId, b.deviceId, 'the one device is vault B\'s genesis device')
  t.ok(listB.devices[0].self, 'and it is the local (self) device')

  const leaked = listB.devices.some((d) => d.deviceId === a.deviceId || d.deviceId === joiner.deviceId)
  t.absent(leaked, 'neither of vault A\'s device ids appears in vault B')

  // ---- A's cores are gone from disk --------------------------------------
  // The engine's device map is rebuilt PURELY from the committed materialized
  // view (which is materialized from the on-disk autobase cores). If A's cores
  // had survived the switch — they share B's deterministic autobase namespace —
  // A's two device records would re-materialize here. Exactly one committed
  // device (B's genesis) proves A's cores were wiped from disk.
  t.is(pe.ctx.sync.devices.size, 1, 'committed device set rebuilt from disk holds only vault B\'s genesis')
})

// Regression (review finding): a vault that arrives via RESTORE_VAULT onto a
// FRESH install must still stamp its vaultId into the header. Without that,
// the header ends up holding only { autobaseKey } (written by sync.open), the
// NEXT switch reads priorVaultId === undefined, and the Fix A2 wipe is
// silently skipped — leaking the restored vault's cores into its successor.
test('Fix A2: restore onto a fresh install stamps vaultId so the NEXT switch still wipes', { timeout: 60000 }, async (t) => {
  const dir = tmp('restore-stamp')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {}; fs.rmSync(dir, { recursive: true, force: true }) })

  // Vault B arrives via restore-from-mnemonic on a fresh install (no prior
  // header, so no reset happens — the stamping must not depend on didReset).
  const mn = identity.generateMnemonic()
  const r = await call(pe, COMMANDS.RESTORE_VAULT, { mnemonic: mn, passphrase: 'pw-b' })
  await pe.ctx.sync.ready(15000)
  await pumpUntil(pe.ctx.sync, () => pe.ctx.sync.devices.size >= 1, { timeoutMs: 8000 })

  const hdr = await pe.vaultStore.getVaultHeader()
  t.is(hdr && hdr.vaultId, r.vaultId, 'restored header carries the vaultId')
  t.ok(hdr && hdr.autobaseKey, 'merge-write preserved the autobaseKey sync.open recorded')

  // Now CREATE a different vault C on the same install — the switch must be
  // detected (via the stamped header) and B's cores wiped.
  const c = await call(pe, COMMANDS.CREATE_VAULT, { label: 'next', platform: 'macos', passphrase: 'pw-c' })
  t.not(c.vaultId, r.vaultId, 'vault C has a different vaultId')
  await pe.ctx.sync.ready(15000)
  await pumpUntil(pe.ctx.sync, () => pe.ctx.sync.devices.size >= 1, { timeoutMs: 8000 })

  const list = await call(pe, COMMANDS.DEVICE_LIST, {})
  t.is(list.devices.filter((d) => d.sealed).length, 0, 'zero sealed rows leaked from the restored vault')
  t.is(list.devices.length, 1, 'DEVICE_LIST(C) returns exactly one device')
  t.is(list.devices[0].deviceId, c.deviceId, 'the one device is vault C\'s genesis device')
  t.is(pe.ctx.sync.devices.size, 1, 'committed device set holds only vault C\'s genesis')
})
