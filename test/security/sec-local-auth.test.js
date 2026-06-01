// Security: local unlock wrapping and high-security restore gates.
//
// Covers:
//   - high-security RESTORE_VAULT verifies the phrase without joining sync or
//     persisting network unlock material;
//   - the local device secret wrapper uses a random per-file Argon2id salt.

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'

import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sec-' + tag + '-')) }
const call = (pe, c, p) => pe.call(c, p || {})

function localSecretRecord (dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'local-device.json'), 'utf8'))
}

test('§16 high-security restore does not unlock, persist keys, or join sync', async (t) => {
  const dir = tmp('restore-high')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  const created = await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  await call(pe, COMMANDS.LOCK_VAULT, {})

  const restored = await call(pe, COMMANDS.RESTORE_VAULT, {
    mnemonic: created.mnemonic,
    passphrase: 'pw',
    highSecurity: true
  })

  t.is(restored.approvalRequired, true, 'high-security restore requires existing-device approval')
  t.is(restored.restored, false, 'high-security restore does not claim network restore')
  t.absent(pe.ctx.isUnlocked(), 'vault remains locked')
  t.is(pe.ctx.state.vaultKeys, null, 'vault keys are not retained in memory')
  t.is(pe.ctx.state.joinedTopic, null, 'device does not join the vault topic')
})

test('§16 local device wrapper stores a random per-file salt', async (t) => {
  const dirA = tmp('salt-a')
  const dirB = tmp('salt-b')
  const peA = await createPearEnd({ storagePath: dirA })
  const peB = await createPearEnd({ storagePath: dirB })
  t.teardown(async () => {
    try { await peA.close() } catch (_) {}
    try { await peB.close() } catch (_) {}
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  await call(peA, COMMANDS.CREATE_VAULT, { label: 'a', platform: 'macos', passphrase: 'same-passphrase' })
  await call(peB, COMMANDS.CREATE_VAULT, { label: 'b', platform: 'macos', passphrase: 'same-passphrase' })

  const a = localSecretRecord(dirA)
  const b = localSecretRecord(dirB)
  t.is(a.v, 2, 'local secret record uses the v2 wrapper format')
  t.is(b.v, 2, 'second local secret record uses the v2 wrapper format')
  t.ok(/^[0-9a-f]{32}$/i.test(a.kdf.salt), 'salt is stored as 16 random bytes')
  t.ok(/^[0-9a-f]{32}$/i.test(b.kdf.salt), 'second salt is stored as 16 random bytes')
  t.not(a.kdf.salt, b.kdf.salt, 'same passphrase on two installs uses different salts')
})
