// Integration: relay-unavailable must NOT block local usage.
//
// Spec §11 failure behavior, §21 Agent 2 acceptance:
//   "Relay unavailable state does not block local usage."
//   App stays local-first / direct-P2P; status reports a degraded reason;
//   lifecycle teardown drains relay loops with no stale references.

import test from 'brittle'
import { makeCtx } from './_relay-harness.js'
import { attach as attachRelay } from '../../backend/relay-service.js'

test('relay calls degrade to local-first when no relay is reachable', async (t) => {
  const h = await makeCtx()
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  const seed = await h.ctx.relay.seedVault('a'.repeat(64), {})
  t.is(seed.ok, false, 'seed fails softly')
  t.is(seed.local, true, 'falls back to local-first')

  const custody = await h.ctx.relay.publishTemporaryCustody('deadbeefroot', 60_000)
  t.is(custody.ok, false, 'custody fails softly')
  t.is(custody.local, true, 'clip kept local')
  t.ok(/no-custody-relay|relay-disabled|client-/.test(custody.reason),
    'reason explains why, reason=' + custody.reason)

  // The crucial property: nothing above threw. Local use is unaffected.
  t.pass('no relay path ever threw or blocked')
})

test('status surfaces a degraded reason and never throws', async (t) => {
  const h = await makeCtx()
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  const status = await h.ctx.relay.getRelayStatus()
  t.is(status.available, false, 'no usable client → not available')
  t.is(status.directPeers, 0, 'no peers in the stub swarm')
  t.is(status.relaysHoldingCiphertext, 0, 'nothing seeded')
  t.is(status.lastVerifierRun, 'never', 'no verifier run yet')
})

test('unlocked auto-seed loop is cancellable and drains on teardown', async (t) => {
  const h = await makeCtx()
  await attachRelay(h.ctx)

  // Publishing a vault-log key triggers the auto-seed spawn under ctx.scope.
  h.ctx.state.vaultLogKey = 'd'.repeat(64)
  h.ctx.emit('unlocked')

  // Immediately tear down — scope.close() must drain the spawned loop
  // (which sleeps 1s) without throwing and without a stale reference.
  const t0 = Date.now()
  await h.cleanup() // calls scope.close() then closes the store
  t.ok(Date.now() - t0 < 5000, 'teardown drained promptly (cooperative cancel)')
  t.pass('scope.close() drained the relay auto-seed loop cleanly')
})

test('disable while a client would exist is safe', async (t) => {
  const h = await makeCtx()
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  await h.ctx.dispatcher.call('RELAY_SET_ENABLED', { enabled: false })
  // Auto-seed must not run while disabled.
  h.ctx.state.vaultLogKey = 'e'.repeat(64)
  h.ctx.emit('unlocked')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const status = await h.ctx.relay.getRelayStatus()
  t.is(status.enabled, false, 'stays disabled')
  t.is(status.available, false, 'no client started while disabled')
})
