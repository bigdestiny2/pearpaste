// Paste desktop clipboard adapter (Agent 3 owns this file).
//
// The OS side of clipboard sync. Agent 1 already registered the CLIP_CAPTURE /
// CLIP_COPY RPC and exposed an internal sink `ctx.clipboardSink({kind, body})`
// (see notes-service.js). This module does NOT touch crypto or sync — it only:
//
//   - reads/writes the desktop OS clipboard via a pluggable backend,
//   - runs an opt-in, cancellable monitor loop (manual-capture vs monitor),
//   - debounces + dedupes captures by HMAC of the clip text (ctx.crypto.hmac),
//   - honors exclusion patterns + a global pause,
//   - feeds captures into ctx.clipboardSink (same path as CLIP_CAPTURE),
//   - never reads the clipboard while the vault is locked,
//   - exposes a renderer-safe control RPC surface via ctx (no extra RPC ids).
//
// Plaintext rules (spec §8.3, §9.4): clipboard text is plaintext and may live
// in OS clipboard APIs + transient memory only. We HMAC it for dedupe (never
// store the text), pass it straight to the sink (which seals it), and keep no
// history. The dedupe key is derived under indexKey so the same digest space
// is vault-scoped and never leaves the process.
//
// Spec refs: §9.4 (tap-to-decrypt), §12 (desktop clipboard integration: manual
// vs monitor, exclusion patterns, quick pause, debounce/dedupe by HMAC), §22
// (one swarm/corestore, cancellable loops, redacted logs).

import b4a from 'b4a'

const DEFAULT_POLL_MS = 1000 // monitor poll interval (spec §3: no faster than needed)
const DEFAULT_DEBOUNCE_MS = 400 // collapse rapid repeats of the same selection
const MAX_CLIP_BYTES = 256 * 1024 // skip pathologically large clipboard payloads

// Heuristic kind classifier. Body itself is never logged.
function classifyKind (text) {
  const t = text.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t) || /^mailto:\S+@\S+$/i.test(t)) return 'url'
  // crude "looks like code" signal: braces/semicolons/indented blocks
  if (/[{};]\s*$|^\s{2,}\S|=>|\bfunction\b|\bconst\b|\bimport\b/m.test(t) && t.includes('\n')) return 'code'
  return 'text'
}

function compileExclusions (patterns) {
  const out = []
  for (const p of patterns || []) {
    if (!p) continue
    if (p instanceof RegExp) { out.push(p); continue }
    try { out.push(new RegExp(String(p), 'i')) } catch (_) { /* skip bad pattern */ }
  }
  return out
}

// --- OS clipboard backend resolution ---------------------------------------
// Order: (1) injected ctx.clipboardBackend (tests / custom shells),
//        (2) pear-electron / Electron `clipboard` if the desktop shell exposed
//            one on ctx (the renderer bridge sets ctx.osClipboard),
//        (3) a no-op backend (headless / CI) so attach() never throws and the
//            CLIP_CAPTURE/CLIP_COPY RPC paths still work without a display.
function resolveBackend (ctx) {
  if (ctx.clipboardBackend && typeof ctx.clipboardBackend.readText === 'function') {
    return ctx.clipboardBackend
  }
  if (ctx.osClipboard && typeof ctx.osClipboard.readText === 'function') {
    return ctx.osClipboard
  }
  // Headless fallback: an in-memory clipboard so logic + tests run anywhere.
  let mem = ''
  return {
    headless: true,
    readText () { return mem },
    writeText (s) { mem = String(s == null ? '' : s) },
    clear () { mem = '' }
  }
}

export async function attach (ctx) {
  // CLIP_CAPTURE/CLIP_COPY RPC ids are owned by notes-service (Agent 1); this
  // module drives the OS side only and adds no new RPC command.
  const log = ctx.log
  const backend = resolveBackend(ctx)

  // Mutable, renderer-visible-but-secretless settings.
  const settings = {
    mode: 'manual', // 'manual' = explicit capture only; 'monitor' = poll OS clipboard
    paused: false, // quick pause toggle (spec §12)
    pollMs: DEFAULT_POLL_MS,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    exclusions: compileExclusions([
      // Conservative defaults: skip obvious secret-manager payloads. The OS
      // cannot always tag sensitive sources, so we also expose user patterns.
      'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY',
      'aws_secret_access_key',
      '^otpauth://'
    ])
  }

  // Dedupe state: last digest we captured + a debounce timestamp. We keep ONLY
  // a keyed digest, never the text (spec §8.3).
  let lastDigestHex = null
  let lastCaptureAt = 0
  let monitorTask = null
  const stats = { captured: 0, deduped: 0, excluded: 0, skippedLocked: 0, errors: 0 }

  // dedupe key derived under indexKey when unlocked so the digest space is
  // vault-scoped; falls back to a static label when keys are absent (the loop
  // does not run while locked anyway, this just keeps the helper total).
  function digestOf (text) {
    const keys = ctx.state && ctx.state.vaultKeys
    const key = keys && keys.indexKey ? keys.indexKey : b4a.from('pearpaste-clip-dedupe-v1')
    return b4a.toString(ctx.crypto.hmac(key, b4a.from(String(text))), 'hex')
  }

  function isExcluded (text) {
    return settings.exclusions.some((re) => re.test(text))
  }

  // Core capture path. Shared by the monitor loop and an explicit
  // "capture current OS clipboard" control. Returns a small status object;
  // NEVER returns or logs the clip body.
  async function captureFromOS ({ force = false } = {}) {
    if (!ctx.isUnlocked()) { stats.skippedLocked++; return { ok: false, reason: 'locked' } }
    let text
    try {
      text = backend.readText()
    } catch (err) {
      stats.errors++
      log.warn('clipboard-read-failed', { err: String((err && err.message) || err) })
      return { ok: false, reason: 'read-failed' }
    }
    if (text == null) return { ok: false, reason: 'empty' }
    text = String(text)
    if (text.length === 0) return { ok: false, reason: 'empty' }
    if (b4a.byteLength(text) > MAX_CLIP_BYTES) return { ok: false, reason: 'too-large' }
    if (isExcluded(text)) { stats.excluded++; return { ok: false, reason: 'excluded' } }

    const digest = digestOf(text)
    const now = Date.now()
    if (!force) {
      if (digest === lastDigestHex && (now - lastCaptureAt) < settings.debounceMs) {
        stats.deduped++
        return { ok: false, reason: 'debounced' }
      }
      if (digest === lastDigestHex) {
        // identical content already captured this session — dedupe (spec §12)
        stats.deduped++
        return { ok: false, reason: 'duplicate' }
      }
    }

    const kind = classifyKind(text)
    let clipId
    try {
      // ctx.clipboardSink is the SAME code path as CLIP_CAPTURE (notes-service)
      // — it seals + appends the op. We never store the plaintext here.
      clipId = await ctx.clipboardSink({ kind, body: text })
    } catch (err) {
      stats.errors++
      log.warn('clipboard-sink-failed', { err: String((err && err.message) || err) })
      return { ok: false, reason: 'sink-failed' }
    }
    lastDigestHex = digest
    lastCaptureAt = now
    stats.captured++
    // redacted: digest + kind only, never the body
    log.info('clip-captured', { kind, digest8: digest.slice(0, 8) })
    ctx.emit('clip-captured', { clipId, kind })
    return { ok: true, clipId, kind }
  }

  // Write a decrypted clip to the OS clipboard then signal a clear. The
  // renderer normally does the OS write itself (it gets plaintext from
  // CLIP_COPY); this helper exists for the tray/global-paste path where the
  // backend drives the write. We do not retain the text.
  async function writeToOS (text, { clearAfterMs = 0 } = {}) {
    if (!ctx.isUnlocked()) return { ok: false, reason: 'locked' }
    text = String(text == null ? '' : text)
    if (text.length === 0) return { ok: false, reason: 'empty' }
    if (b4a.byteLength(text) > MAX_CLIP_BYTES) return { ok: false, reason: 'too-large' }
    try {
      backend.writeText(text)
    } catch (err) {
      log.warn('clipboard-write-failed', { err: String((err && err.message) || err) })
      return { ok: false, reason: 'write-failed' }
    }
    // Mark this digest as "ours" so the monitor loop does not re-capture the
    // value we just programmatically wrote (avoids a paste->capture echo).
    try { lastDigestHex = digestOf(text); lastCaptureAt = Date.now() } catch (_) {}
    if (clearAfterMs > 0) {
      const t = setTimeout(() => {
        try {
          if (backend.readText() === text && backend.clear) backend.clear()
        } catch (_) {}
      }, clearAfterMs)
      if (t.unref) t.unref()
    }
    ctx.emit('clip-written', {})
    return { ok: true }
  }

  // --- monitor loop (opt-in, cancellable via ctx.scope — spec §22) ---------
  function startMonitor () {
    if (monitorTask) return
    if (backend.headless) {
      // Nothing to poll without a real OS clipboard; manual capture still works.
      log.info('clipboard-monitor-skipped', { reason: 'headless-backend' })
      return
    }
    // The loop sleeps in short fixed slices and samples only when at least
    // settings.pollMs has elapsed. This (a) keeps idle cost low (spec §3: no
    // polling faster than necessary — we only READ the OS clipboard every
    // pollMs), and (b) makes mode/pause/pollMs changes take effect within one
    // slice instead of being stuck behind a long in-flight sleep.
    const SLICE_MS = 50
    monitorTask = ctx.scope.spawn(async (scope) => {
      log.info('clipboard-monitor-started', { pollMs: settings.pollMs })
      let lastSampleAt = 0
      while (!scope.cancelled) {
        try {
          const now = Date.now()
          if (settings.mode === 'monitor' && !settings.paused && !settings._bgPaused &&
              ctx.isUnlocked() && (now - lastSampleAt) >= settings.pollMs) {
            lastSampleAt = now
            await captureFromOS()
          }
        } catch (_) { /* loop must never throw past here */ }
        try { await scope.sleep(Math.min(SLICE_MS, settings.pollMs)) } catch (_) { break }
      }
      log.info('clipboard-monitor-stopped')
    }, 'clipboard-monitor')
  }

  // Locking must stop sampling immediately (no clipboard reads while locked,
  // spec §15). The loop checks isUnlocked() each tick; clear dedupe state too
  // so a post-unlock identical clip is still captured intentionally.
  ctx.on('locked', () => { lastDigestHex = null; lastCaptureAt = 0 })
  // Backgrounding pauses sampling without losing the user's mode preference.
  ctx.on('backgrounded', () => { settings._bgPaused = true })
  ctx.on('foregrounded', () => { settings._bgPaused = false })

  // Start the loop now; it self-gates on mode/paused/lock so it is cheap when
  // monitoring is off (the default).
  startMonitor()
  ctx.scope.onClose(async () => { /* scope.close() cancels monitorTask */ })

  // --- control surface (no NEW rpc command ids; exposed on ctx) ------------
  // The renderer reaches these via the bridge's __clipboard helper (index.js).
  ctx.clipboard = {
    get settings () {
      return {
        mode: settings.mode,
        paused: settings.paused || !!settings._bgPaused,
        pollMs: settings.pollMs,
        debounceMs: settings.debounceMs,
        exclusionCount: settings.exclusions.length
      }
    },
    get stats () { return { ...stats } },
    setMode (mode) {
      if (mode !== 'manual' && mode !== 'monitor') throw new Error('mode must be manual|monitor')
      settings.mode = mode
      ctx.emit('clipboard-mode-changed', { mode })
      return this.settings
    },
    setPaused (paused) {
      settings.paused = !!paused
      ctx.emit('clipboard-pause-changed', { paused: settings.paused })
      return this.settings
    },
    setPollMs (ms) {
      const n = Number(ms)
      if (!(n >= 10 && n <= 60000)) throw new Error('pollMs must be 10..60000')
      settings.pollMs = n // loop re-reads this each tick
      return this.settings
    },
    setDebounceMs (ms) {
      const n = Number(ms)
      if (!(n >= 0 && n <= 60000)) throw new Error('debounceMs must be 0..60000')
      settings.debounceMs = n
      return this.settings
    },
    setExclusions (patterns) {
      settings.exclusions = compileExclusions(patterns)
      return this.settings
    },
    // Explicit "grab whatever is on the OS clipboard right now" — used by the
    // manual-capture button and the global hotkey path.
    captureNow () { return captureFromOS({ force: false }) },
    captureNowForce () { return captureFromOS({ force: true }) },
    // Backend-driven OS write (tray/global-paste). The renderer-driven path
    // writes directly from CLIP_COPY plaintext instead.
    writeToOS,
    _backendHeadless: !!backend.headless
  }

  log.info('clipboard attached', { backend: backend.headless ? 'headless' : 'os', mode: settings.mode })
}

export default { attach }
