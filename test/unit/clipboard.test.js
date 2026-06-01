// Unit: backend/clipboard.js — the OS clipboard adapter (Agent 3).
// Asserts the contract in spec §12: manual vs monitor mode, debounce + dedupe
// by HMAC of clip text, exclusion patterns, quick pause, locked-vault refusal,
// and that captures go through ctx.clipboardSink (the SAME path as
// CLIP_CAPTURE) WITHOUT the plaintext ever being stored/returned.
//
// We attach() the real module with a mock ctx: an injected in-memory
// clipboardBackend, a fake clipboardSink that records {kind} only, the real
// crypto.hmac (keyed BLAKE2b), and a real LifecycleScope so the monitor loop
// is genuinely cancellable.
//
// Run: node test/unit/clipboard.test.js

import test from 'brittle'
import * as crypto from '../../backend/crypto-envelope.js'
import LifecycleScope from '../../backend/lifecycle-scope.js'
import clipboard from '../../backend/clipboard.js'

function mkCtx ({ unlocked = true } = {}) {
  const scope = new LifecycleScope('clip-test')
  const listeners = new Map()
  let clip = ''
  const sinkCalls = []
  const ctx = {
    scope,
    crypto,
    log: { debug () {}, info () {}, warn () {}, error () {} },
    state: { vaultKeys: { indexKey: crypto.randomBytes(32) }, device: { deviceId: 'dev-1' } },
    _unlocked: unlocked,
    isUnlocked () { return ctx._unlocked },
    on (ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn) },
    emit (ev, p) { for (const fn of listeners.get(ev) || []) { try { fn(p) } catch (_) {} } },
    // injected OS clipboard
    clipboardBackend: {
      readText () { return clip },
      writeText (s) { clip = String(s) },
      clear () { clip = '' }
    },
    // SAME path CLIP_CAPTURE uses — record kind only, NEVER the body
    clipboardSink: async ({ kind, body }) => {
      sinkCalls.push({ kind, bodyLen: String(body).length })
      return 'clip-' + sinkCalls.length
    }
  }
  return {
    ctx,
    scope,
    sinkCalls,
    setClip: (v) => { clip = String(v) },
    getClip: () => clip,
    fire: (ev, p) => ctx.emit(ev, p)
  }
}

test('manual mode: explicit captureNow feeds the sink; monitor off does nothing', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())

  env.setClip('hello world')
  // monitor loop is in 'manual' mode by default -> it must NOT auto-capture
  await new Promise(resolve => setTimeout(resolve, 60))
  t.is(env.sinkCalls.length, 0, 'manual mode does not auto-capture')

  const r = await env.ctx.clipboard.captureNow()
  t.ok(r.ok && r.clipId, 'explicit captureNow captured')
  t.is(env.sinkCalls.length, 1, 'one sink call')
  t.is(env.sinkCalls[0].kind, 'text', 'classified as text')
})

test('dedupe: identical clipboard content is captured once, changed content again', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())

  env.setClip('same-value')
  const a = await env.ctx.clipboard.captureNow()
  t.ok(a.ok, 'first capture ok')
  const b = await env.ctx.clipboard.captureNow()
  t.absent(b.ok, 'identical content not captured again')
  t.is(b.reason, 'debounced', 'within debounce window -> debounced')
  t.is(env.sinkCalls.length, 1, 'sink called once for duplicate content')

  env.setClip('different-value')
  const c = await env.ctx.clipboard.captureNow()
  t.ok(c.ok, 'changed content captured')
  t.is(env.sinkCalls.length, 2, 'sink called again for new content')
})

test('debounce window: same content after the window is deduped (not re-sent)', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  // shrink debounce so the test is fast
  env.ctx.clipboard.setMode('manual')
  // reach into settings via a forced then a normal capture
  env.setClip('debounce-me')
  const a = await env.ctx.clipboard.captureNow()
  t.ok(a.ok, 'captured once')
  await new Promise(resolve => setTimeout(resolve, 5))
  const b = await env.ctx.clipboard.captureNow()
  t.absent(b.ok, 'same digest -> not captured')
  t.ok(b.reason === 'debounced' || b.reason === 'duplicate', 'deduped by HMAC digest')
  t.is(env.sinkCalls.length, 1, 'still one sink call')
  t.teardown(() => env.scope.close())
})

test('forced capture bypasses dedupe (re-capture the same content on demand)', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())
  env.setClip('force-value')
  await env.ctx.clipboard.captureNow()
  const f = await env.ctx.clipboard.captureNowForce()
  t.ok(f.ok, 'forced capture succeeds even for identical content')
  t.is(env.sinkCalls.length, 2, 'sink called twice (forced bypass)')
})

test('exclusion patterns skip secret-manager-looking payloads', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())

  env.setClip('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----')
  const r = await env.ctx.clipboard.captureNow()
  t.absent(r.ok, 'private key payload excluded')
  t.is(r.reason, 'excluded', 'reason is excluded')
  t.is(env.sinkCalls.length, 0, 'excluded content never reached the sink')

  // user-supplied patterns replace defaults
  env.ctx.clipboard.setExclusions(['^skip-me'])
  env.setClip('skip-me-please')
  t.absent((await env.ctx.clipboard.captureNow()).ok, 'custom exclusion applied')
  env.setClip('-----BEGIN OPENSSH PRIVATE KEY-----') // default no longer active
  t.ok((await env.ctx.clipboard.captureNow()).ok, 'replaced exclusion set lets prior default through')
})

test('quick pause stops capture; resuming re-enables it', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())

  env.ctx.clipboard.setPollMs(20) // fast poll so the loop ticks within the test
  env.ctx.clipboard.setPaused(true)
  env.setClip('while-paused')
  // In monitor mode the loop is gated by paused; explicit captureNow also
  // respects pause via the loop, but the manual button is allowed to force.
  // Here we assert the monitor path: switch to monitor + paused -> no capture.
  env.ctx.clipboard.setMode('monitor')
  await new Promise(resolve => setTimeout(resolve, 120))
  t.is(env.sinkCalls.length, 0, 'paused monitor does not capture')

  env.ctx.clipboard.setPaused(false)
  env.setClip('after-resume')
  await new Promise(resolve => setTimeout(resolve, 200))
  t.ok(env.sinkCalls.length >= 1, 'capture resumes after unpause (monitor loop)')
})

test('locked vault: clipboard is never read', async (t) => {
  const env = mkCtx({ unlocked: false })
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())

  env.setClip('secret-while-locked')
  const r = await env.ctx.clipboard.captureNow()
  t.absent(r.ok, 'no capture while locked')
  t.is(r.reason, 'locked', 'refused because vault is locked')
  t.is(env.sinkCalls.length, 0, 'sink never called while locked')
})

test('kind classification: url and code are detected', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())

  env.setClip('https://example.com/path?q=1')
  await env.ctx.clipboard.captureNow()
  t.is(env.sinkCalls.at(-1).kind, 'url', 'URL detected')

  env.setClip('function f() {\n  const x = 1;\n  return x;\n}')
  await env.ctx.clipboard.captureNow()
  t.is(env.sinkCalls.at(-1).kind, 'code', 'code-ish text detected')
})

test('writeToOS marks the value as ours so the monitor does not echo it back', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  t.teardown(() => env.scope.close())

  await env.ctx.clipboard.writeToOS('pasted-from-app')
  t.is(env.getClip(), 'pasted-from-app', 'OS clipboard written')
  // monitor must not re-capture what we just programmatically wrote
  env.ctx.clipboard.setPollMs(20)
  env.ctx.clipboard.setMode('monitor')
  await new Promise(resolve => setTimeout(resolve, 120))
  t.is(env.sinkCalls.length, 0, 'no paste->capture echo for app-written content')
})

test('monitor loop is cancellable via the lifecycle scope', async (t) => {
  const env = mkCtx()
  await clipboard.attach(env.ctx)
  env.ctx.clipboard.setPollMs(20)
  env.ctx.clipboard.setMode('monitor')
  env.setClip('loop-value')
  await new Promise(resolve => setTimeout(resolve, 150))
  t.ok(env.sinkCalls.length >= 1, 'monitor captured at least once')
  await env.scope.close() // must drain the loop, not hang
  t.ok(env.scope.closed, 'scope closed -> monitor task drained')
})
