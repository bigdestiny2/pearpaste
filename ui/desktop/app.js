// Paste desktop UI.
//
// Screens (spec §12): Unlock, Create/Restore vault (24-word phrase shown once
// + confirm), Notes (sealed rows + tap-to-decrypt editor), Recent Clips
// (sealed), Search, Devices, Pair device (QR + short code), Encryption Proof,
// Relay Status, Settings.
//
// Renderer contract (spec §15, enforced by backend): the UI never holds vault
// keys; list rows are sealed; plaintext arrives ONLY from NOTE_OPEN/CLIP_OPEN/
// CLIP_COPY for the one item the user acts on. Plaintext is cleared on
// close / lock / background / visibility timeout (spec §9.4).
//
// This is a small hand-rolled view layer (no remote framework, CSP-safe). It
// is robust if the bridge transport is missing (shows a recoverable state).
//
// Visual layer ported from website/styles.css (see docs/DESIGN_SPEC.md).

import { createBridgeClient } from '../shared/bridge-client.js'
import { COPY, assertCopyClean } from '../shared/copy.js'
import { qrToSvg } from '../shared/qr.js'
import { h, mount } from '../shared/dom.js'

// pear-electron exposes `app.tray()` for a menubar icon. In `pear run --dev .`
// the dock icon is locked to the Pear runtime's bundle (can't be overridden);
// the tray is the one place we CAN put the Paste brand on screen in dev.
// In a built .app the dock icon comes from pear.json gui.icon — tray is purely
// additive there.
let ui = null
try { ui = (await import('pear-electron')).default || (await import('pear-electron')) } catch (_) { /* not available outside pear-electron runtime */ }

assertCopyClean() // fail fast if a banned UX phrase slipped into COPY

const bridge = createBridgeClient()
const appEl = document.getElementById('app')
const OS_CLIPBOARD_CLEAR_MS = 60000
const REDUCE_MOTION = typeof window !== 'undefined' && window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ---- session state (NO vault keys ever; only the one open item's plaintext) -
const S = {
  locked: true,
  view: 'notes',
  banner: null, // { kind, text }
  notes: [],
  clips: [],
  devices: [],
  searchResults: null,
  open: null, // { type:'note'|'clip', id, data, openedAt } — the ONE decrypted item
  openTimer: null,
  visibilityMs: 60000,
  invite: null, // pairing invite (PAIR_CREATE_INVITE result)
  pairRequest: null, // pending source-side approval request
  relay: null,
  proof: null,
  clipboard: null, // backend clipboard settings/stats
  pendingPhrase: null // { mnemonic, vaultId } shown once after CREATE_VAULT
}

// Inline SVG helper. Trusted, locally-built fragments only (CSP-safe).
function svg (innerHtml, opts = {}) {
  const size = opts.size || 18
  const viewBox = opts.viewBox || '0 0 24 24'
  return h('span', {
    class: 'svg-wrap',
    html: '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="' + viewBox + '" fill="none" stroke="currentColor" stroke-width="' +
      (opts.strokeWidth || 1.7) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      innerHtml + '</svg>'
  })
}

// Brand SVG matches website/index.html line 22 (clipboard + lock badge,
// stroked in the brand gradient). Different gradient id per instance so
// multiple inlines on the page don't clobber each other.
let _brandGradSeq = 0
function brandSvg (size = 24) {
  const id = 'brandGrad' + (++_brandGradSeq)
  const inner =
    '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>' +
    '<rect x="6" y="4.5" width="20" height="23" rx="4.5" fill="none" stroke="url(#' + id + ')" stroke-width="2.4"/>' +
    '<rect x="11.5" y="2.6" width="9" height="5.4" rx="2.4" fill="none" stroke="url(#' + id + ')" stroke-width="2.4"/>' +
    '<circle cx="16" cy="18.2" r="3.1" fill="none" stroke="url(#' + id + ')" stroke-width="2.2"/>' +
    '<path d="M16 21.3v3" stroke="url(#' + id + ')" stroke-width="2.2" stroke-linecap="round"/>'
  return h('span', {
    class: 'brand-svg',
    html: '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 32 32" aria-hidden="true">' + inner + '</svg>'
  })
}

// Hero brand composition: gradient-ringed icon + gradient wordmark + 3px
// gradient underline accent + optional tagline. Desktop counterpart of
// mobile/app/lib/ui.js <GradientBrandMark>. Use on unlock/create/restore,
// phrase reveal, bridge-error fallback, and the boot splash.
function brandHero ({ size = 'md', tagline = null, iconPx = null } = {}) {
  const innerSize = iconPx || (size === 'sm' ? 30 : 44)
  return h('div', { class: 'brand-hero' + (size === 'sm' ? ' sm' : '') },
    h('div', { class: 'icon-ring' }, brandSvg(innerSize)),
    h('div', { class: 'word' }, 'Paste'),
    h('div', { class: 'bar', 'aria-hidden': 'true' }),
    tagline ? h('div', { class: 'tagline' }, tagline) : null
  )
}

// Nav icons (18px) — picked to match the website's SVG language.
const NAV_ICONS = {
  notes: '<path d="M5 4h11l3 3v13a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z"/><path d="M14 4v4h4"/><path d="M8 12h7M8 16h5"/>',
  clips: '<rect x="8" y="3" width="12" height="14" rx="2"/><path d="M16 17v2a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  devices: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v7h-7"/>',
  relay: '<circle cx="12" cy="12" r="3"/><path d="M3 12h4M17 12h4M12 3v4M12 17v4"/>',
  proof: '<path d="M12 3l7 4v5c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V7z"/><path d="M9.5 12l2 2 3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'
}

const LOCK_OPEN_PATH = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018-2"/>'
const LOCK_CLOSED_PATH = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'

function setBanner (kind, text, autohide = true) {
  S.banner = text ? { kind, text } : null
  render()
  if (text && autohide && kind !== 'err') setTimeout(() => { if (S.banner && S.banner.text === text) { S.banner = null; render() } }, 3500)
}

// Explicit plaintext clearing (spec §9.4). Tells the backend to drop its copy
// too (NOTE_CLOSE/CLIP_CLOSE) so nothing decrypted survives.
function clearOpen (notifyBackend = true) {
  if (S.openTimer) { clearTimeout(S.openTimer); S.openTimer = null }
  const cur = S.open
  S.open = null
  // Only notify the backend for an item it actually decrypted (has a real id).
  // A new, never-saved note has no server-side plaintext to drop, and calling
  // NOTE_CLOSE/CLIP_CLOSE with a null id fails schema validation.
  if (cur && notifyBackend && typeof cur.id === 'string' && cur.id) {
    const fn = cur.type === 'note' ? bridge.noteClose : bridge.clipClose
    Promise.resolve(fn(cur.id)).catch(() => {})
  }
}

function armVisibilityTimer () {
  if (S.openTimer) clearTimeout(S.openTimer)
  // never across lock/background — those clear immediately via events below.
  S.openTimer = setTimeout(() => {
    setBanner('warn', 'Opened item auto-closed after ' + Math.round(S.visibilityMs / 1000) + 's. Plaintext cleared.')
    clearOpen(true)
    render()
  }, S.visibilityMs)
  if (S.openTimer.unref) S.openTimer.unref()
}

// ---- backend event stream: lock/background clear plaintext immediately -----
bridge.onEvent((event, payload) => {
  if (event === 'locked') {
    S.locked = true
    clearOpen(false) // backend already dropped it on lock
    S.notes = []; S.clips = []; S.devices = []; S.searchResults = null
    setBanner('warn', 'Vault locked. Decrypted content cleared.', false)
  } else if (event === 'unlocked') {
    S.locked = false
  } else if (event === 'pair-approval-needed') {
    S.pairRequest = payload
    S.view = 'devices'
    setBanner('warn', 'Pairing request pending. Confirm the code before approving.', false)
  } else if (event === 'pair-approval-cleared' || event === 'pair-rejected' || event === 'pair-admitted') {
    if (!payload || !S.pairRequest || payload.requestId === S.pairRequest.requestId || payload.deviceId === S.pairRequest.deviceId) {
      S.pairRequest = null
    }
  } else if (event === 'clip-captured') {
    if (S.view === 'clips') refreshClips()
  }
  render()
})

// Backgrounding clears the open item (spec §9.4/§15). Signal the backend over
// the desktop bridge; here we also clear UI state defensively.
let _lastBackendVisible = null
function setBackendVisibility (visible) {
  const v = !!visible
  if (_lastBackendVisible === v) return
  _lastBackendVisible = v
  if (bridge && typeof bridge.setVisibility === 'function') {
    try { bridge.setVisibility(v) } catch (_) {}
  }
}

window.addEventListener('blur', () => {
  setBackendVisibility(false)
  if (S.open) { setBanner('warn', 'Window backgrounded — opened item closed.', false) }
  clearOpen(true)
  render()
})
window.addEventListener('focus', () => {
  setBackendVisibility(true)
})
document.addEventListener('visibilitychange', () => {
  setBackendVisibility(!document.hidden)
  if (document.hidden && S.open) { clearOpen(true); render() }
})

// ---- data loaders ---------------------------------------------------------
async function refreshNotes () {
  try { S.notes = (await bridge.noteList({})).notes || [] } catch (e) { S.notes = []; if (e.code !== 'LOCKED') setBanner('err', COPY.errorPrefix + e.message) }
  render()
}
async function refreshClips () {
  try { S.clips = (await bridge.clipList({})).clips || [] } catch (e) { S.clips = [] }
  render()
}
async function refreshDevices () {
  try { S.devices = (await bridge.deviceList()).devices || [] } catch (e) { S.devices = [] }
  render()
}
async function refreshRelay () {
  try { S.relay = await bridge.relayStatus() } catch (e) { S.relay = { available: false, degradedReason: e.message } }
  // Network exposure (Phase 1 of the network-privacy work). Fetched in
  // parallel with RELAY_STATUS so the panel shows live data without an
  // extra round-trip. Falls back to a zero-state shape on error so the UI
  // never explodes on a dead backend.
  try { S.network = await bridge.networkStatus() } catch (_) {
    S.network = { peerCount: 0, relayCount: 0, peers: [], relays: [], vias: { dht: 0, relayCircuit: 0, unknown: 0 } }
  }
  render()
}
async function refreshClipboard () {
  try { S.clipboard = await bridge.clipboard('status') } catch (_) { S.clipboard = { available: false } }
  render()
}

function classifyClipKind (text) {
  const t = String(text || '').trim()
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t) || /^mailto:\S+@\S+$/i.test(t)) return 'url'
  if (/[{};]\s*$|^\s{2,}\S|=>|\bfunction\b|\bconst\b|\bimport\b/m.test(t) && t.includes('\n')) return 'code'
  return 'text'
}

async function clearOSClipboardIfUnchanged (text, ms = OS_CLIPBOARD_CLEAR_MS) {
  if (!navigator.clipboard || !navigator.clipboard.readText || !navigator.clipboard.writeText) return
  setTimeout(async () => {
    try {
      if (await navigator.clipboard.readText() === text) await navigator.clipboard.writeText('')
    } catch (_) {}
  }, ms)
}

// ---- view-level UI atoms --------------------------------------------------
function eyebrow (text) { return h('span', { class: 'eyebrow' }, text) }

function sectionHead (eyebrowText, title, lede) {
  const kids = [eyebrow(eyebrowText), h('h1', { class: 'section-title' }, title)]
  if (lede) kids.push(h('p', { class: 'lede' }, lede))
  return h('div', { class: 'section-head reveal' }, ...kids)
}

function lockPill () {
  const unlocked = !S.locked
  return h('span', { class: 'lockpill ' + (unlocked ? 'unlocked' : 'locked') },
    svg(unlocked ? LOCK_OPEN_PATH : LOCK_CLOSED_PATH, { size: 13, strokeWidth: 1.8 }),
    unlocked ? 'Unlocked' : 'Locked')
}

function topbar () {
  return h('div', { class: 'topbar' },
    h('span', { class: 'brand' },
      brandSvg(24),
      'Paste',
      h('span', { class: 'by' }, '/ private clipboard')
    ),
    h('span', { class: 'spacer' }),
    lockPill(),
    !S.locked && h('button', {
      class: 'sm ghost',
      onclick: async () => { try { await bridge.lock() } catch (_) {} }
    }, COPY.lockAction)
  )
}

function navItem (id, label, iconKey) {
  return h('button', {
    class: S.view === id ? 'active' : '',
    onclick: () => { S.view = id; onEnterView(id); render() }
  },
  h('span', { class: 'nav-ico', html: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + NAV_ICONS[iconKey] + '</svg>' }),
  h('span', null, label))
}

function shell (content) {
  return h('div', { class: 'shell' },
    h('div', { class: 'nav' },
      navItem('notes', 'Notes', 'notes'),
      navItem('clips', 'Recent clips', 'clips'),
      navItem('search', 'Search', 'search'),
      navItem('devices', 'Devices', 'devices'),
      navItem('relay', 'Relay status', 'relay'),
      navItem('proof', 'Encryption proof', 'proof'),
      navItem('settings', 'Settings', 'settings')
    ),
    h('div', { class: 'main' }, content)
  )
}

function bannerEl () {
  if (!S.banner) return null
  return h('div', { class: 'banner ' + (S.banner.kind === 'err' ? 'err' : S.banner.kind === 'ok' ? 'ok' : 'warn') }, S.banner.text)
}

// ---- Unlock / Create / Restore / Pair -------------------------------------
function unlockScreen () {
  let secret = ''
  let mnemonic = ''
  let passphrase = ''
  let inviteBlob = ''
  let pairSecret = ''
  let mode = 'unlock' // 'unlock' | 'create' | 'restore' | 'pair'

  const wrap = h('div')
  function paint () {
    const body = []
    // Hero brand block (matches mobile splash/unlock). The mode-specific h1
    // sits below it so brand identity reads first, then the actionable task.
    body.push(h('div', { style: 'margin-bottom: 18px' },
      brandHero({ size: 'md', tagline: COPY.tagline })))
    if (mode !== 'unlock') {
      body.push(h('h2', { class: 'section-title', style: 'text-align:center; font-size:22px; margin: 10px 0 18px' },
        mode === 'create' ? 'Create your vault'
          : mode === 'restore' ? 'Restore your vault'
            : 'Pair this device'))
    }

    // Segmented mode control. Four options match the mobile lock screen so a
    // fresh device can join an existing vault (Pair) without first creating
    // a throwaway local one.
    body.push(h('div', { style: 'display:flex; justify-content:center; margin-bottom: 20px' },
      h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Vault mode' },
        h('button', { class: mode === 'unlock' ? 'active' : '', role: 'tab', 'aria-selected': mode === 'unlock' ? 'true' : 'false', onclick: () => { mode = 'unlock'; paint() } }, 'Unlock'),
        h('button', { class: mode === 'create' ? 'active' : '', role: 'tab', 'aria-selected': mode === 'create' ? 'true' : 'false', onclick: () => { mode = 'create'; paint() } }, 'Create'),
        h('button', { class: mode === 'restore' ? 'active' : '', role: 'tab', 'aria-selected': mode === 'restore' ? 'true' : 'false', onclick: () => { mode = 'restore'; paint() } }, 'Restore'),
        h('button', { class: mode === 'pair' ? 'active' : '', role: 'tab', 'aria-selected': mode === 'pair' ? 'true' : 'false', onclick: () => { mode = 'pair'; paint() } }, 'Pair')
      )))

    body.push(bannerEl())

    if (mode === 'unlock') {
      body.push(h('label', null, COPY.unlockTitle))
      body.push(h('p', { class: 'hint' }, COPY.unlockHint))
      body.push(h('input', { type: 'password', placeholder: 'Passphrase', oninput: (e) => { secret = e.target.value } }))
      body.push(h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: async () => {
          try { await bridge.unlock(secret, 'passphrase'); S.locked = false; S.view = 'notes'; onEnterView('notes'); setBanner('ok', 'Vault unlocked.'); render() } catch (e) { setBanner('err', e.code === 'NO_VAULT' ? 'No vault on this device yet — create, restore, or pair.' : COPY.errorPrefix + e.message) }
        } }, COPY.unlockAction)
      ))
    } else if (mode === 'create') {
      body.push(h('p', { class: 'hint' }, COPY.createHint))
      body.push(h('label', null, 'Passphrase (used to unlock this device later)'))
      body.push(h('input', { type: 'password', placeholder: 'Choose a passphrase', oninput: (e) => { passphrase = e.target.value } }))
      body.push(h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: async () => {
          try {
            const r = await bridge.createVault({ label: 'desktop', platform: hostPlatform(), passphrase })
            S.pendingPhrase = { mnemonic: r.mnemonic, vaultId: r.vaultId }
            S.locked = false
            render() // -> phrase screen
          } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
        } }, COPY.createAction)
      ))
    } else if (mode === 'restore') {
      body.push(h('p', { class: 'hint' }, COPY.restoreHint))
      body.push(h('label', null, COPY.restoreTitle))
      body.push(h('textarea', { placeholder: 'word1 word2 … word24', oninput: (e) => { mnemonic = e.target.value.trim() } }))
      body.push(h('label', null, 'Passphrase (optional)'))
      body.push(h('input', { type: 'password', placeholder: 'Optional passphrase', oninput: (e) => { passphrase = e.target.value } }))
      body.push(h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: async () => {
          try {
            await bridge.restoreVault({ mnemonic, passphrase })
            // root-device split: RESTORE sets keys; UNLOCK reloads signer.
            try { await bridge.unlock(passphrase || mnemonic, 'passphrase') } catch (_) {}
            S.locked = false; S.view = 'notes'; onEnterView('notes'); setBanner('ok', 'Vault restored.'); render()
          } catch (e) { setBanner('err', e.code === 'BAD_MNEMONIC' ? 'That recovery phrase is not valid.' : COPY.errorPrefix + e.message) }
        } }, COPY.restoreAction)
      ))
    } else { // mode === 'pair'
      // Accept a pairing invite from an already-unlocked device. EITHER form
      // works: the 8-char short code (e.g. A1B2-C3D4) OR the full long invite
      // payload. Short codes resolve over a DHT rendezvous topic (the inviter
      // also announces on a topic derived from the code); the FULL invite is
      // still the cryptographic root — the confirmation phrase keeps MITM
      // protection regardless of which input the user chose.
      body.push(h('p', { class: 'hint' }, COPY.pairAccepting))
      body.push(h('label', null, 'Short code or full invite'))
      body.push(h('textarea', {
        placeholder: 'A1B2-C3D4   — or paste the full invite payload',
        oninput: (e) => { inviteBlob = e.target.value.trim() }
      }))
      body.push(h('label', null, 'Unlock passphrase for this device'))
      body.push(h('input', {
        type: 'password',
        placeholder: 'Choose a passphrase',
        oninput: (e) => { pairSecret = e.target.value }
      }))
      body.push(h('p', { class: 'hint' }, 'On your unlocked device: Devices → Pair a device. Either the short code shown next to the QR or the full invite text works here.'))
      body.push(h('div', { class: 'actions' },
        h('button', {
          class: 'primary' + (S.pairBusy ? ' busy' : ''),
          disabled: S.pairBusy ? true : null,
          onclick: async () => {
            if (!inviteBlob) { setBanner('err', 'Enter a short code or paste the full invite first.'); return }
            if (!pairSecret.trim()) { setBanner('err', 'Choose an unlock passphrase for this device first.'); return }
            if (S.pairBusy) return
            const looksLikeCode = /^[0-9A-Fa-f-]{4,12}$/.test(inviteBlob.replace(/\s/g, ''))
            S.pairBusy = true; render()
            try {
              let blob = inviteBlob
              if (looksLikeCode) {
                setBanner('warn', 'Looking up short code over the DHT…', false)
                const r = await bridge.pairLookupShortCode(inviteBlob.replace(/\s/g, ''), 30000)
                blob = r.invite
              }
              setBanner('warn', 'Pairing — syncing from your unlocked device…', false)
              await bridge.pairAccept(blob, 'desktop', hostPlatform(), pairSecret)
              S.locked = false; S.view = 'notes'; onEnterView('notes')
              setBanner('ok', 'Device paired. Sync is starting.')
            } catch (e) {
              if (e.code === 'SHORTCODE_NOT_FOUND') setBanner('err', 'Short code not found on the DHT. Check it matches the code on your unlocked device (and that the invite hasn\'t expired), then try again.')
              else if (e.code === 'BAD_SHORT_CODE') setBanner('err', 'Short code must be 8 hex chars (e.g. A1B2-C3D4).')
              else if (e.code === 'PAIRING_EXPIRED') setBanner('err', 'That pairing invite expired. Create a new one on the unlocked device.')
              else setBanner('err', COPY.errorPrefix + e.message)
            } finally {
              S.pairBusy = false; render()
            }
          }
        }, S.pairBusy
          ? h('span', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Pairing…')
          : COPY.pairAcceptAction)
      ))
    }
    // Reassurance row (chip-row) below the form
    body.push(h('div', { class: 'chip-row', style: 'margin-top:20px; justify-content:center' },
      h('span', { class: 'chip' }, svg('<path d="M12 3l7 4v5c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V7z"/>', { size: 13, strokeWidth: 1.8 }), 'No accounts, ever'),
      h('span', { class: 'chip' }, svg(LOCK_CLOSED_PATH, { size: 13, strokeWidth: 1.8 }), 'Encrypted on-device'),
      h('span', { class: 'chip' }, svg('<path d="M5 4h14v16l-7-3-7 3z"/>', { size: 13, strokeWidth: 1.8 }), 'Offline-first')
    ))

    mount(wrap, h('div', { class: 'card center-card' }, ...body.filter(Boolean)))
  }
  paint()
  return wrap
}

// One-time recovery phrase screen (spec §14: shown once + confirm; never persisted)
function phraseScreen () {
  const words = String(S.pendingPhrase.mnemonic).trim().split(/\s+/)
  let confirmed = false
  const wrap = h('div')
  function paint () {
    mount(wrap, h('div', { class: 'card center-card' },
      h('div', { style: 'margin-bottom: 14px' }, brandHero({ size: 'sm' })),
      h('h1', { class: 'section-title', style: 'text-align:center; font-size:24px' }, COPY.phraseTitle),
      h('div', { class: 'banner warn' }, COPY.phraseWarn),
      h('div', { class: 'phrase-grid' }, ...words.map((w, i) =>
        h('div', { class: 'w' }, h('span', { class: 'n' }, String(i + 1).padStart(2, '0')), w))),
      h('label', { style: 'text-transform:none; letter-spacing:.01em; font-weight:500; color:var(--muted)' },
        h('input', { type: 'checkbox', onchange: (e) => { confirmed = e.target.checked; paint() } }),
        ' ' + COPY.phraseConfirm),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', disabled: !confirmed, onclick: () => {
          // discard plaintext phrase from UI memory immediately (never persist)
          S.pendingPhrase = null
          S.view = 'notes'; onEnterView('notes'); setBanner('ok', 'Vault created. Recovery phrase discarded from the app.'); render()
        } }, COPY.phraseContinue)
      )
    ))
  }
  paint()
  return wrap
}

// ---- Notes ----------------------------------------------------------------
function bucketLabel (b) {
  if (!b) return ''
  return 'modified ' + String(b)
}
function notesScreen () {
  const body = [
    sectionHead('Your vault', COPY.notesTitle, 'Titles and bodies are sealed. An item is decrypted only when you open it.'),
    bannerEl(),
    h('div', { class: 'actions reveal', 'data-d': '1' },
      h('button', { class: 'primary', onclick: () => openNoteEditor(null) }, COPY.newNote),
      h('button', { class: 'ghost', onclick: refreshNotes }, 'Refresh'))
  ]
  if (S.open && S.open.type === 'note') {
    body.push(noteEditorOrViewer())
  }
  if (!S.notes.length) {
    body.push(h('div', { class: 'empty reveal', 'data-d': '2' }, COPY.notesEmpty))
  } else {
    body.push(h('div', { class: 'list reveal', 'data-d': '2' }, ...S.notes.map((n) => {
      // Row title: user-set label if present (lets users disambiguate notes
      // without opening them); otherwise the sealed fallback.
      const labelled = n.label && n.label.length > 0
      const rowTitle = labelled ? n.label : COPY.sealedRow
      const titleClass = labelled ? 't' : 't sealed-title'
      return h('div', { class: 'row', onclick: () => openNoteEditor(n.id) },
        h('span', { class: 'ico', html:
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
          (n.bodyFormat === 'code'
            ? '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>'
            : '<path d="M5 4h11l3 3v13a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z"/><path d="M14 4v4h4"/><path d="M8 12h7M8 16h5"/>') +
          '</svg>' }),
        h('div', { class: 'meta' },
          h('div', { class: titleClass }, rowTitle),
          h('div', { class: 's' }, bucketLabel(n.updatedBucket))),
        h('div', { class: 'row-actions' },
          n.pinned ? h('span', { class: 'badge pin' }, 'pinned') : null,
          // Temporary-note chip: shows remaining time. Past-expiry rows are
          // filtered out by the backend list handler, but a row arriving
          // *exactly* at expiry could slip through — show "expired" then.
          n.expiresAt ? h('span', { class: 'badge temp', title: 'Temporary — erased after this window' },
            svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', { size: 11, strokeWidth: 1.8 }),
            ' ' + COPY.temporaryExpiresPrefix + ' ' + (formatRemaining(n.expiresAt - Date.now()) || COPY.temporaryExpiredLabel)) : null,
          h('span', { class: 'badge sealed' }, 'sealed'),
          // Inline trash button — stops row's openNoteEditor onclick from
          // firing. Opens the confirm modal; the actual erase runs hard-delete
          // via bridge.noteDelete(id, true) on confirm.
          //
          // Only rendered when n.id is present. Orphan rows from prior
          // CREATE_VAULT cycles carry only objectBlindId; the NOTE_DELETE
          // schema requires a string noteId, so clicking would throw
          // "missing required field: noteId". Hiding the affordance is
          // honest — these rows can be cleared by wiping app-storage.
          n.id
            ? h('button', {
              class: 'row-trash danger sm',
              title: COPY.deleteNote,
              'aria-label': COPY.deleteConfirmAction + ' "' + (labelled ? n.label : 'sealed note') + '"',
              onclick: (e) => { e.stopPropagation(); requestHardDeleteNote(n.id, labelled ? n.label : null) }
            },
            svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/>',
              { size: 14, strokeWidth: 1.8 }))
            : null
        ))
    })))
  }
  return h('div', null, ...body.filter(Boolean))
}

// Stage a hard-delete confirmation. The actual erase runs only after the user
// confirms in the modal — this guards a single click from being destructive.
// `displayLabel` is what we show in the prompt ("Erase 'foo'?") when the note
// has a user-set label or open title; null falls back to the generic prompt.
function requestHardDeleteNote (noteId, displayLabel) {
  S.deleteConfirm = { kind: 'note', noteId, displayLabel: displayLabel || null }
  render()
}

async function performHardDeleteNote () {
  const c = S.deleteConfirm
  if (!c || c.kind !== 'note') return
  S.deleteConfirm = null
  try {
    // hard=true → backend's _applyNoteDelete batch.del's the encrypted
    // envelope from the materialized view and removes the search index entry.
    // The signed NOTE_DELETE op replicates so paired devices apply the same
    // erase. Relay-held ciphertext is unreadable (vault key never reached
    // the relay); the local store no longer carries the envelope at all.
    await bridge.noteDelete(c.noteId, true)
    // If this was the currently-open note in the editor, drop the plaintext
    // shell state too — the backend has already closed the item.
    if (S.open && S.open.id === c.noteId) clearOpen(false)
    await refreshNotes()
    setBanner('ok', COPY.deleteSucceeded)
  } catch (e) {
    setBanner('err', COPY.errorPrefix + e.message)
  }
  render()
}

// Modal shown when a delete is requested. Two buttons: confirm (danger
// gradient on the website's red palette) + cancel (ghost). Esc and clicking
// the dim backdrop both cancel.
function deleteConfirmModal () {
  const c = S.deleteConfirm
  if (!c) return null
  const subject = c.displayLabel ? '"' + c.displayLabel + '"' : 'this note'
  return h('div', {
    class: 'modal-bg',
    onclick: (e) => { if (e.target.classList.contains('modal-bg')) { S.deleteConfirm = null; render() } }
  }, h('div', { class: 'card modal' },
    h('h2', { class: 'section-title', style: 'font-size:20px; margin-bottom: 10px' }, COPY.deleteConfirmTitle),
    h('p', { class: 'lede', style: 'margin: 8px 0 6px' }, 'Erase ' + subject + '?'),
    h('p', { class: 'hint' }, COPY.deleteConfirmBody),
    h('div', { class: 'editor-actions' },
      h('button', { class: 'danger', onclick: performHardDeleteNote }, COPY.deleteConfirmAction),
      h('button', { class: 'ghost', onclick: () => { S.deleteConfirm = null; render() } }, COPY.cancel)
    )
  ))
}

// Same modal pattern as deleteConfirmModal, but parameterised for the device
// revoke flow. Carries a label/platform/deviceId so the confirm subject reads
// naturally ("Revoke 'iPhone'?"). Backdrop click + Esc both cancel.
function requestRevokeDevice (deviceId, displayLabel) {
  S.revokeConfirm = { deviceId, displayLabel: displayLabel || null }
  render()
}
async function performRevokeDevice () {
  const c = S.revokeConfirm
  if (!c) return
  S.revokeConfirm = null
  try {
    await bridge.deviceRevoke(c.deviceId)
    await refreshDevices()
    setBanner('ok', COPY.revokeSucceeded)
  } catch (e) {
    setBanner('err', COPY.errorPrefix + e.message)
  }
  render()
}
function revokeConfirmModal () {
  const c = S.revokeConfirm
  if (!c) return null
  const subject = c.displayLabel ? '"' + c.displayLabel + '"' : 'this device'
  return h('div', {
    class: 'modal-bg',
    onclick: (e) => { if (e.target.classList.contains('modal-bg')) { S.revokeConfirm = null; render() } }
  }, h('div', { class: 'card modal' },
    h('h2', { class: 'section-title', style: 'font-size:20px; margin-bottom: 10px' }, COPY.revokeConfirmTitle),
    h('p', { class: 'lede', style: 'margin: 8px 0 6px' }, 'Revoke ' + subject + '?'),
    h('p', { class: 'hint' }, COPY.revokeConfirmBody),
    h('div', { class: 'editor-actions' },
      h('button', { class: 'danger', onclick: performRevokeDevice }, COPY.revokeConfirmAction),
      h('button', { class: 'ghost', onclick: () => { S.revokeConfirm = null; render() } }, COPY.cancel)
    )
  ))
}

async function openNoteEditor (noteId) {
  clearOpen(true)
  if (noteId == null) {
    // New note: skip view step and land directly in the editor.
    S.open = { type: 'note', id: null, editing: true, data: { title: '', body: '', bodyFormat: 'plain', pinned: false, label: '' }, openedAt: Date.now() }
    render()
    return
  }
  try {
    const r = await bridge.noteOpen(noteId)
    // Existing note: land in READ-ONLY view first (matches mobile's two-step
    // open→edit pattern — deliberate edit on explicit Edit click, not a side
    // effect of just looking at a note).
    S.open = { type: 'note', id: noteId, editing: false, data: r.note, openedAt: Date.now() }
    armVisibilityTimer()
    render()
  } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
}

// Decide between read-only viewer (existing note, fresh open) and the
// editable form (new note OR existing note after the user taps Edit).
function noteEditorOrViewer () {
  if (S.open.id && !S.open.editing) return noteViewer()
  return noteEditor()
}

// Read-only viewer for an opened note. Mirrors mobile's intermediate
// open-state — title as H1, body in a card, then Close + Edit buttons.
function noteViewer () {
  const d = S.open.data
  const remaining = () => Math.max(0, Math.round((S.visibilityMs - (Date.now() - S.open.openedAt)) / 1000))
  // Build the chip row above the body: label chip (if set) + temporary-
  // countdown chip (if expiresAt set). Surfacing the expiry here is the
  // mobile equivalent of letting the reader know the note will erase, even
  // if they bypassed the list (e.g. opened via search).
  const chips = []
  if (d.label) chips.push(h('span', { class: 'chip ok' }, d.label))
  if (d.expiresAt && d.expiresAt > Date.now()) {
    chips.push(h('span', { class: 'chip warn', title: 'Temporary — erased after this window' },
      svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', { size: 13, strokeWidth: 1.8 }),
      ' ' + COPY.temporaryExpiresPrefix + ' ' + (formatRemaining(d.expiresAt - Date.now()) || COPY.temporaryExpiredLabel)))
  }
  return h('div', { class: 'card' },
    h('div', { style: 'display:flex; align-items:center; gap:10px; margin-bottom: 6px' },
      h('strong', { style: 'font-size:18px' }, d.label || '(unlabeled)'),
      h('span', { class: 'timerbar' }, 'auto-close in ~' + remaining() + 's')
    ),
    chips.length
      ? h('div', { class: 'chip-row', style: 'margin: 4px 0 12px' }, ...chips)
      : null,
    h('div', { class: 'note-body', style: 'white-space:pre-wrap; word-break:break-word; font-family: ' + (d.bodyFormat === 'code' ? 'var(--fm)' : 'inherit') + '; color:var(--text); line-height:1.6; padding:10px 0;' }, d.body || ''),
    h('p', { class: 'hint' }, 'Closing this note clears the decrypted text from memory.'),
    h('div', { class: 'editor-actions' },
      h('button', { class: 'primary', onclick: () => { clearOpen(true); render() } }, COPY.closeItem),
      h('button', { class: 'ghost', onclick: () => { S.open.editing = true; render() } }, 'Edit')
    )
  )
}

// Temporary-note TTL options. Each option's ms value is added to Date.now()
// at save time so the absolute expiresAt is anchored on save, not creation —
// editing a temp note extends its life. Default 72h matches the user's brief.
const TTL_OPTIONS = [
  { ms: 60 * 60 * 1000, label: '1 hour' },
  { ms: 12 * 60 * 60 * 1000, label: '12 hours' },
  { ms: 24 * 60 * 60 * 1000, label: '24 hours' },
  { ms: 72 * 60 * 60 * 1000, label: '72 hours' },
  { ms: 7 * 24 * 60 * 60 * 1000, label: '7 days' },
  { ms: 30 * 24 * 60 * 60 * 1000, label: '30 days' }
]
const TTL_DEFAULT_MS = 72 * 60 * 60 * 1000

// Format a remaining duration for a sealed-row chip: "3d", "12h", "45m", "30s".
// Coarse on purpose — relays + sync mean we can't promise second-precision.
function formatRemaining (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return sec + 's'
  const min = Math.floor(sec / 60)
  if (min < 60) return min + 'm'
  const hr = Math.floor(min / 60)
  if (hr < 48) return hr + 'h'
  const d = Math.floor(hr / 24)
  return d + 'd'
}

function noteEditor () {
  const d = S.open.data
  let bodyv = d.body || ''
  let fmt = d.bodyFormat || 'plain'
  let pinned = !!d.pinned
  // Editor identifier: prefer label, fall back to legacy title for notes
  // saved before the title/label unification. Saving writes label only.
  let label = d.label || d.title || ''
  // Temporary-note state: derive from the open note. A note with a future
  // expiresAt is temporary; choose the closest TTL preset that brackets it
  // so the dropdown shows a sensible value. New notes default to off.
  let isTemporary = !!(d.expiresAt && d.expiresAt > Date.now())
  let ttlMs = TTL_DEFAULT_MS
  if (isTemporary) {
    const remainingMs = Math.max(0, d.expiresAt - Date.now())
    // Pick the smallest preset that is >= remainingMs (so the dropdown
    // "rounds up" to a value that doesn't shrink the remaining life).
    const matched = TTL_OPTIONS.find(o => o.ms >= remainingMs)
    ttlMs = matched ? matched.ms : TTL_OPTIONS[TTL_OPTIONS.length - 1].ms
  }
  const remaining = () => Math.max(0, Math.round((S.visibilityMs - (Date.now() - S.open.openedAt)) / 1000))
  // Wrapper so the segmented format control can re-render its active state
  // without re-rendering the rest of the editor (which would lose input focus).
  const fmtWrap = h('div')
  function paintFmt () {
    mount(fmtWrap, h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Body format' },
      ...['plain', 'markdown', 'code'].map((f) =>
        h('button', { class: fmt === f ? 'active' : '', role: 'radio', 'aria-checked': fmt === f ? 'true' : 'false', onclick: () => { fmt = f; paintFmt() } }, f))))
  }
  paintFmt()
  // Wrapper for the temporary-note block so toggling the checkbox shows /
  // hides the TTL picker without losing other editor input state.
  const tempWrap = h('div')
  function paintTemp () {
    const children = [
      h('label', { style: 'text-transform:none; letter-spacing:.01em; font-weight:500; color:var(--muted); margin-top: 14px' },
        h('input', { type: 'checkbox', checked: isTemporary, onchange: (e) => { isTemporary = e.target.checked; paintTemp() } }),
        ' ' + COPY.temporaryToggle),
      h('p', { class: 'hint' }, COPY.temporaryHint)
    ]
    if (isTemporary) {
      children.push(h('label', null, COPY.temporaryTtlLabel))
      children.push(h('select', { onchange: (e) => { ttlMs = Number(e.target.value) } },
        ...TTL_OPTIONS.map((o) =>
          h('option', { value: String(o.ms), selected: o.ms === ttlMs }, o.label))))
    }
    mount(tempWrap, h('div', null, ...children))
  }
  paintTemp()
  return h('div', { class: 'card' },
    h('div', { style: 'display:flex; align-items:center; gap:10px; margin-bottom: 6px' },
      h('strong', { style: 'font-size:18px' }, S.open.id ? (label || '(unlabeled)') : 'New note'),
      S.open.id && h('span', { class: 'timerbar' }, 'auto-close in ~' + remaining() + 's')
    ),
    h('label', null, COPY.labelField),
    h('input', { value: label, placeholder: COPY.labelPlaceholder, maxlength: 80, oninput: (e) => { label = e.target.value } }),
    h('p', { class: 'hint' }, COPY.labelHint),
    h('label', null, 'Body'),
    h('textarea', { value: bodyv, placeholder: 'Your note (sealed once saved)', oninput: (e) => { bodyv = e.target.value } }),
    h('label', null, 'Format'),
    fmtWrap,
    h('label', { style: 'text-transform:none; letter-spacing:.01em; font-weight:500; color:var(--muted); margin-top: 14px' },
      h('input', { type: 'checkbox', checked: pinned, onchange: (e) => { pinned = e.target.checked } }),
      ' Pinned (ordering only — not decrypted)'),
    tempWrap,
    h('div', { class: 'editor-actions' },
      h('button', { class: 'primary', onclick: async () => {
        try {
          // Anchor expiresAt at SAVE time so editing a temp note extends its
          // life by the chosen TTL. expiresAt=0 (or omitted) = persistent;
          // backend treats only positive values as a temporary marker.
          const expiresAt = isTemporary ? (Date.now() + ttlMs) : 0
          const note = { body: bodyv, bodyFormat: fmt, pinned, label, expiresAt }
          if (S.open.id) note.noteId = S.open.id
          await bridge.noteUpsert(note)
          clearOpen(true)
          await refreshNotes()
          setBanner('ok', isTemporary
            ? 'Note saved (sealed). Erases in ' + (formatRemaining(ttlMs) || '?') + '.'
            : 'Note saved (sealed).')
        } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
      } }, COPY.saveNote),
      S.open.id && h('button', {
        class: 'danger',
        onclick: () => requestHardDeleteNote(S.open.id, label || null)
      }, COPY.deleteNote),
      h('button', { class: 'ghost', onclick: () => {
        // For an existing note in edit mode, return to the viewer instead of
        // closing entirely (matches mobile's Cancel that drops you back to the
        // read-only view). For a brand-new note (no id yet) Cancel == discard.
        if (S.open.id) { S.open.editing = false; render() }
        else { clearOpen(true); render() }
      } }, S.open.id ? 'Cancel' : COPY.closeItem)
    )
  )
}

// ---- Clips ----------------------------------------------------------------
function clipsScreen () {
  const body = [
    sectionHead('Recent', COPY.clipsTitle, 'Rows are sealed. The clip text is decrypted only when you copy it.'),
    bannerEl(),
    h('div', { class: 'actions reveal', 'data-d': '1' },
      h('button', { class: 'primary', onclick: captureCurrentClipboard }, COPY.captureNow),
      h('button', { class: 'ghost', onclick: refreshClips }, 'Refresh'))
  ]
  if (!S.clips.length) body.push(h('div', { class: 'empty reveal', 'data-d': '2' }, COPY.clipsEmpty))
  else {
    body.push(h('div', { class: 'list reveal', 'data-d': '2' }, ...S.clips.map((c) =>
      h('div', { class: 'row' },
        h('span', { class: 'ico', html:
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
          (c.kind === 'url'
            ? '<path d="M9 15l6-6M9.5 8.5L12 6a4 4 0 015.7 5.7L15 14M14.5 15.5L12 18a4 4 0 01-5.7-5.7L9 10"/>'
            : c.kind === 'code'
              ? '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>'
              : '<rect x="8" y="3" width="12" height="14" rx="2"/><path d="M16 17v2a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2"/>') +
          '</svg>' }),
        h('div', { class: 'meta', onclick: () => copyClip(c.id) },
          h('div', { class: 't' }, COPY.sealedRow),
          h('div', { class: 's' }, (c.kind || 'text') + ' · ' + (c.bucket || ''))),
        h('div', { class: 'row-actions' },
          h('span', { class: 'badge sealed' }, 'sealed'),
          h('button', { class: 'sm', onclick: () => copyClip(c.id) }, COPY.copyClip))
      )
    )))
  }
  return h('div', null, ...body.filter(Boolean))
}

async function captureCurrentClipboard () {
  let text = ''
  try {
    if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText()
  } catch (_) {}
  if (text) {
    try {
      await bridge.clipCapture(classifyClipKind(text), text)
      text = ''
      setBanner('ok', 'Captured current clipboard.')
      await refreshClips()
      return
    } catch (e) {
      text = ''
      setBanner('err', COPY.errorPrefix + e.message)
      return
    }
  }
  try {
    const r = await bridge.clipboard('captureNow')
    const ok = r && r.ok
    const reason = (r && r.reason) || 'n/a'
    setBanner(ok ? 'ok' : 'warn', ok ? 'Captured current clipboard.' : 'Nothing captured (' + reason + ').')
    refreshClips()
  } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
}

async function copyClip (clipId) {
  try {
    const r = await bridge.clipCopy(clipId) // returns plaintext for OS clipboard ONLY
    let wrote = false
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(r.body)
        clearOSClipboardIfUnchanged(r.body)
        wrote = true
      }
    } catch (_) {}
    if (!wrote) {
      // fallback: ask the backend clipboard adapter to write + auto-clear
      try {
        await bridge.clipboard('writeToOS', {
          text: r.body,
          opts: { clearAfterMs: OS_CLIPBOARD_CLEAR_MS }
        })
        wrote = true
      } catch (_) {}
    }
    // r.body is a transient local — drop our reference immediately (spec §9.4)
    r.body = null
    setBanner('ok', wrote ? COPY.copiedCleared : 'Decrypted, but OS clipboard write was blocked.')
  } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
}

// ---- Search ---------------------------------------------------------------
function searchScreen () {
  let q = ''
  const wrap = h('div')
  function paint () {
    const body = [
      sectionHead('Local index', 'Search', 'Results are sealed until you open one.'),
      bannerEl(),
      h('input', { placeholder: COPY.searchPlaceholder, 'aria-label': COPY.searchPlaceholder, oninput: (e) => { q = e.target.value }, onkeydown: async (e) => {
        if (e.key === 'Enter') { try { S.searchResults = (await bridge.search(q)).results || [] } catch (err) { setBanner('err', COPY.errorPrefix + err.message) } paint() }
      } })
    ]
    if (S.searchResults != null) {
      if (!S.searchResults.length) body.push(h('div', { class: 'empty', style: 'margin-top: 16px' }, COPY.searchEmpty))
      // Backend SEARCH now emits `id` (noteId/clipId) alongside objectBlindId so
      // the row routes a tap straight to NOTE_OPEN/CLIP_OPEN (see
      // backend/notes-service.js SEARCH handler). Rows without `id` came back
      // unresolved (paired device, orphan record) and stay sealed/non-clickable.
      else body.push(h('div', { class: 'list', style: 'margin-top: 16px' }, ...S.searchResults.map((r) => {
        const clickable = !!r.id && (r.type === 'note' || r.type === 'clip')
        const onclick = clickable
          ? (r.type === 'clip' ? (() => { S.view = 'clips'; onEnterView('clips'); render() }) : (() => openNoteEditor(r.id)))
          : null
        return h('div', { class: 'row' + (clickable ? '' : ' disabled'), onclick },
          h('span', { class: 'ico', html:
            '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
            (r.type === 'clip'
              ? '<rect x="8" y="3" width="12" height="14" rx="2"/><path d="M16 17v2a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2"/>'
              : '<path d="M5 4h11l3 3v13a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z"/>') +
            '</svg>' }),
          h('div', { class: 'meta' },
            h('div', { class: 't' }, COPY.sealedRow),
            h('div', { class: 's' }, r.type + ' · ' + (clickable ? 'tap to open' : 'open in ' + (r.type === 'clip' ? 'Recent clips' : 'Notes') + ' tab'))),
          h('span', { class: 'badge sealed' }, 'sealed'))
      })))
    }
    mount(wrap, h('div', null, ...body.filter(Boolean)))
  }
  paint()
  return wrap
}

// ---- Devices + Pairing ----------------------------------------------------
function devicesScreen () {
  const body = [
    sectionHead('Trusted devices', COPY.devicesTitle, 'Each device signs with its own key. Revoke any at any time.'),
    bannerEl(),
    h('div', { class: 'actions reveal', 'data-d': '1' },
      h('button', { class: 'primary', onclick: createInvite }, COPY.pairAction),
      h('button', { class: 'ghost', onclick: refreshDevices }, 'Refresh'))
  ]
  if (S.invite) body.push(invitePanel())
  if (S.pairRequest) body.push(pairApprovalPanel())
  if (!S.devices.length) body.push(h('div', { class: 'empty' }, 'No devices listed yet.'))
  else body.push(h('div', { class: 'list' }, ...S.devices.map((d) =>
    h('div', { class: 'row' },
      h('span', { class: 'ico', html:
        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>' +
        '</svg>' }),
      h('div', { class: 'meta' },
        h('div', { class: 't' }, d.sealed ? COPY.sealedRow : (d.label || d.deviceId)),
        h('div', { class: 's' }, d.sealed ? 'sealed device record' : ((d.platform || '') + (d.revoked ? ' · revoked' : '') + ' · ' + (d.roles || []).join(',')))),
      h('div', { class: 'row-actions' },
        d.sealed ? h('span', { class: 'badge sealed' }, 'sealed') : null,
        !d.sealed && !d.revoked && h('button', {
          class: 'danger sm',
          onclick: () => requestRevokeDevice(d.deviceId, d.label || d.platform || null)
        }, COPY.revokeAction)
      )
    ))))
  return h('div', null, ...body.filter(Boolean))
}

async function createInvite () {
  try {
    S.invite = await bridge.pairCreateInvite(5 * 60 * 1000)
    render()
  } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
}

function invitePanel () {
  const sv = qrToSvg(S.invite.invite, { scale: 5 })
  return h('div', { class: 'card' },
    h('strong', null, COPY.pairTitle),
    h('p', { class: 'hint' }, COPY.pairHint),
    sv ? h('div', { class: 'qr-wrap', html: sv }) : h('div', { class: 'hint' }, 'Invite is too long for a QR — paste the long invite text below into the other device.'),
    h('div', { class: 'kv', style: 'margin-top:14px' },
      h('div', { class: 'k' }, COPY.pairShortCode), h('div', { class: 'v mono' }, S.invite.shortCode),
      h('div', { class: 'k' }, COPY.pairExpires), h('div', { class: 'v' }, new Date(S.invite.expiresAt).toLocaleTimeString())),
    h('p', { class: 'hint', style: 'font-size:11px; margin-top:6px' },
      'The short code starts discovery only. Approve the matching request on this unlocked device before keys are released.'),
    h('label', null, 'Invite payload'),
    h('textarea', { readonly: 'readonly', value: S.invite.invite, onclick: (e) => e.target.select() })
  )
}

function pairApprovalPanel () {
  const req = S.pairRequest
  return h('div', { class: 'card' },
    h('strong', null, 'Approve pairing request'),
    h('p', { class: 'hint' }, 'Confirm this code matches on the new device before approving. The short code only finds this invite; approval releases the encrypted bootstrap.'),
    h('div', { class: 'kv', style: 'margin-top:10px' },
      h('div', { class: 'k' }, 'Device'), h('div', { class: 'v' }, (req.label || 'paired') + ' · ' + (req.platform || 'unknown')),
      h('div', { class: 'k' }, 'Confirm code'), h('div', { class: 'v mono' }, req.confirmation || '------'),
      h('div', { class: 'k' }, 'Expires'), h('div', { class: 'v' }, req.expiresAt ? new Date(req.expiresAt).toLocaleTimeString() : 'soon')),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: async () => {
        try { await bridge.pairApprove(req.requestId); S.pairRequest = null; await refreshDevices(); setBanner('ok', 'Device approved. Sync is starting.') } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
      } }, 'Approve'),
      h('button', { class: 'danger', onclick: async () => {
        try { await bridge.pairReject(req.requestId); S.pairRequest = null; setBanner('warn', 'Pairing request rejected.') } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
      } }, 'Reject')
    )
  )
}

// ---- Relay status ---------------------------------------------------------
function relayScreen () {
  const r = S.relay
  const body = [
    sectionHead('Availability', COPY.relayTitle, COPY.relayBlurb),
    bannerEl(),
    h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: refreshRelay }, 'Refresh'))
  ]
  if (!r) body.push(h('div', { class: 'empty' }, 'Loading relay status…'))
  else {
    if (r.available === false) body.push(h('div', { class: 'banner warn' }, COPY.relayReduced + (r.degradedReason ? ' — ' + r.degradedReason : '')))
    body.push(h('div', { class: 'card' },
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, COPY.relayDirectPeers), h('div', { class: 'v' }, String(r.directPeers ?? 0)),
        h('div', { class: 'k' }, COPY.relayHolding), h('div', { class: 'v' }, String(r.relaysHoldingCiphertext ?? 0)),
        h('div', { class: 'k' }, COPY.relayQuorum), h('div', { class: 'v' }, String(r.custodyQuorum ?? '0/0')),
        h('div', { class: 'k' }, COPY.relayLastVerifier), h('div', { class: 'v' }, String(r.lastVerifierRun ?? 'never')),
        h('div', { class: 'k' }, COPY.relayLastRotation), h('div', { class: 'v' }, r.lastKeyRotation ? new Date(r.lastKeyRotation).toLocaleString() : '—'))
    ))
    body.push(h('div', { class: 'card' },
      h('strong', null, COPY.relayEnabledLabel),
      h('p', { class: 'hint' }, 'Relays store encrypted blocks only. Disabling keeps Paste local-first and direct-P2P.'),
      h('label', { style: 'text-transform:none; letter-spacing:.01em; font-weight:500; color:var(--muted)' },
        h('input', { type: 'checkbox', checked: r.enabled !== false, onchange: async (e) => {
          try { await bridge.relaySetEnabled(e.target.checked); await refreshRelay() } catch (err) { setBanner('err', COPY.errorPrefix + err.message) }
        } }),
        ' ' + COPY.relayEnabledLabel)
    ))
    // ---- Network exposure panel (Phase 1) -------------------------------
    body.push(networkExposureCard())
  }
  return h('div', null, ...body.filter(Boolean))
}

// Pure-disclosure panel: lists the direct peers + relays that see this
// device's IP right now, with the connection-path classification. No
// security improvement on its own — the value is honesty (the website's
// "Not anonymous" disclaimer becomes actionable when the user can see
// exactly what's leaking and decide what to do). Data shape comes from
// NETWORK_STATUS RPC, fetched alongside RELAY_STATUS in refreshRelay().
function networkExposureCard () {
  const n = S.network || { peerCount: 0, relayCount: 0, peers: [], relays: [], vias: { dht: 0, relayCircuit: 0, unknown: 0 } }
  const peerNoun = n.peerCount === 1 ? COPY.networkSummaryPeer : COPY.networkSummaryPeers
  const relayNoun = n.relayCount === 1 ? COPY.networkSummaryRelay : COPY.networkSummaryRelays
  // Headline reads naturally: "Your IP is currently visible to 3 paired
  // devices and 8 relays." Joined inline so screen readers parse it as
  // a single sentence rather than disconnected chips.
  const summary = COPY.networkSummaryPrefix +
    n.peerCount + ' ' + peerNoun + ' and ' + n.relayCount + ' ' + relayNoun + '.'
  const peerList = n.peers && n.peers.length
    ? h('ul', { class: 'expose-list' }, ...n.peers.map((p) => h('li', null,
        h('span', { class: 'expose-id mono' }, p.id || '—'),
        h('span', { class: 'expose-via' }, viaLabel(p.via)))))
    : h('p', { class: 'hint' }, COPY.networkPeersEmpty)
  const relayList = n.relays && n.relays.length
    ? h('ul', { class: 'expose-list' }, ...n.relays.map((rr) => h('li', null,
        h('span', { class: 'expose-id mono' }, rr.id || '—'),
        h('span', { class: 'expose-via' }, 'fleet relay'))))
    : h('p', { class: 'hint' }, COPY.networkRelaysEmpty)
  return h('div', { class: 'card' },
    h('div', { style: 'display:flex; align-items:center; gap:10px; margin-bottom:6px' },
      h('strong', { style: 'font-size:15.5px' }, COPY.networkTitle)),
    h('p', { class: 'hint' }, COPY.networkBlurb),
    h('p', { style: 'color:var(--text); margin:10px 0 4px' }, summary),
    h('hr'),
    h('label', null, COPY.networkPeersHeader),
    peerList,
    h('label', null, COPY.networkRelaysHeader),
    relayList,
    h('p', { class: 'hint', style: 'margin-top:12px' }, COPY.networkHonestyHint)
  )
}
function viaLabel (via) {
  if (via === 'dht') return COPY.networkViaDht
  if (via === 'relay-circuit') return COPY.networkViaRelayCircuit
  return COPY.networkViaUnknown
}

// ---- Encryption proof -----------------------------------------------------
// Classify a proof line for color-coding. Mirrors website terminal styling.
function proofLineSpan (ln) {
  if (/FAILED|FAIL\b/.test(ln)) return { cls: 'fail', text: ln }
  if (/^Limit:|^\s*Limit/.test(ln)) return { cls: 'dim', text: ln }
  if (/^\$/.test(ln)) return { cls: 'cmd', text: ln }
  if (/passed|verified|valid|signed|encrypted|RESULT: PASS|no plaintext/i.test(ln)) return { cls: 'ok', text: ln }
  if (/warn/i.test(ln)) return { cls: 'warn', text: ln }
  return { cls: 'dim', text: ln }
}

function proofScreen () {
  // Inline busy-state on the verify button (mirrors mobile's
  // `<Button busy={verifying}>`) instead of a transient banner. The button
  // shows a spinner glyph + "Running…" while disabled, then flips back.
  const body = [
    sectionHead('Security', COPY.proofTitle, COPY.proofBlurb),
    bannerEl(),
    h('div', { class: 'actions reveal', 'data-d': '1' },
      h('button', {
        class: 'primary' + (S.proofRunning ? ' busy' : ''),
        disabled: S.proofRunning ? true : null,
        onclick: async () => {
          if (S.proofRunning) return
          S.proofRunning = true; render()
          try {
            S.proof = await bridge.verifyEncryption()
            setBanner(S.proof.passed ? 'ok' : 'err', S.proof.passed ? 'Verifier passed.' : 'Verifier reported a failure.')
          } catch (e) { setBanner('err', COPY.errorPrefix + e.message) }
          finally { S.proofRunning = false; render() }
        }
      }, S.proofRunning
        ? h('span', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Running verifier…')
        : COPY.proofRun))
  ]
  if (S.proof) {
    const preInner = S.proof.lines.map((ln) => {
      const { cls, text } = proofLineSpan(ln)
      return '<span class="' + cls + '">' + escapeHtml(text) + '</span>'
    }).join('\n')
    body.push(h('div', { class: 'proof-terminal reveal', 'data-d': '2' },
      h('div', { class: 'bar' },
        h('span', { class: 'dot' }), h('span', { class: 'dot' }), h('span', { class: 'dot' }),
        h('span', { class: 't' }, 'paste — encryption proof')),
      h('pre', { html: preInner })))
    body.push(h('p', { class: 'hint' }, 'Proof version ' + S.proof.proofVersion + ' · last run ' + S.proof.lastRun))
  } else {
    body.push(h('div', { class: 'proof-terminal reveal', 'data-d': '2' },
      h('div', { class: 'bar' },
        h('span', { class: 'dot' }), h('span', { class: 'dot' }), h('span', { class: 'dot' }),
        h('span', { class: 't' }, 'paste — encryption proof')),
      h('pre', { html:
        '<span class="cmd">$ paste --verify-encryption</span>\n\n' +
        '<span class="dim">Run the verifier to scan local storage, logs,\nsignatures, and relay custody.</span>'
      })))
  }
  return h('div', null, ...body.filter(Boolean))
}

function escapeHtml (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---- Settings -------------------------------------------------------------
function settingsScreen () {
  const cb = S.clipboard
  const body = [
    sectionHead('Preferences', COPY.settingsTitle, 'Local-only choices. None of these sync.'),
    bannerEl()
  ]
  // Clipboard capture disclosure
  body.push(h('details', { class: 'disclosure', open: 'open' },
    h('summary', null, COPY.settingClipMode, h('span', { class: 'pm' }, '+')),
    h('div', { class: 'a' },
      h('p', { class: 'hint' }, 'Monitor mode samples the OS clipboard on a timer. Manual mode only captures when you press the button.'),
      h('label', null, COPY.settingClipMode),
      h('select', {
        onchange: async (e) => { try { S.clipboard = await bridge.clipboard('setMode', e.target.value); setBanner('ok', 'Clipboard mode: ' + e.target.value) } catch (err) { setBanner('err', COPY.errorPrefix + err.message) } render() }
      },
        h('option', { value: 'manual', selected: !cb || cb.settings?.mode !== 'monitor' }, COPY.settingClipModeManual),
        h('option', { value: 'monitor', selected: cb && cb.settings?.mode === 'monitor' }, COPY.settingClipModeMonitor)),
      h('label', { style: 'text-transform:none; letter-spacing:.01em; font-weight:500; color:var(--muted)' },
        h('input', { type: 'checkbox', checked: cb && cb.settings?.paused, onchange: async (e) => { try { S.clipboard = await bridge.clipboard('setPaused', e.target.checked) } catch (_) {} render() } }),
        ' ' + COPY.settingClipPause),
      cb && cb.settings && cb.settings.exclusionCount != null && h('p', { class: 'hint' }, cb.settings.exclusionCount + ' exclusion pattern(s) active. Secret-manager payloads are skipped by default.'),
      cb && cb.stats && h('p', { class: 'hint' }, 'Captured ' + cb.stats.captured + ' · deduped ' + cb.stats.deduped + ' · excluded ' + cb.stats.excluded)
    )
  ))
  // Visibility timeout disclosure
  body.push(h('details', { class: 'disclosure' },
    h('summary', null, COPY.settingVisibility, h('span', { class: 'pm' }, '+')),
    h('div', { class: 'a' },
      h('p', { class: 'hint' }, 'How long a decrypted note/clip stays open before it is auto-closed. Never persists across lock or background.'),
      h('select', { onchange: (e) => { S.visibilityMs = Number(e.target.value); if (S.open && S.open.id) armVisibilityTimer(); setBanner('ok', 'Auto-close set to ' + (S.visibilityMs / 1000) + 's') } },
        ...[15000, 30000, 60000, 120000].map((ms) => h('option', { value: ms, selected: ms === S.visibilityMs }, (ms / 1000) + ' seconds')))
    )
  ))
  // About disclosure with reassurance chip row
  body.push(h('details', { class: 'disclosure' },
    h('summary', null, 'About ' + COPY.appName, h('span', { class: 'pm' }, '+')),
    h('div', { class: 'a' },
      h('p', null, COPY.appName + ' — ' + COPY.tagline),
      h('p', { style: 'margin-top:10px' }, 'No account, no server. Your notes are encrypted on this device before they enter the P2P network. Relays store encrypted blocks only.'),
      h('div', { class: 'chip-row', style: 'margin-top:14px' },
        h('span', { class: 'chip' }, svg('<path d="M12 3l7 4v5c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V7z"/>', { size: 13, strokeWidth: 1.8 }), 'No accounts, ever'),
        h('span', { class: 'chip' }, svg(LOCK_CLOSED_PATH, { size: 13, strokeWidth: 1.8 }), 'Encrypted on-device'),
        h('span', { class: 'chip' }, svg('<path d="M5 4h14v16l-7-3-7 3z"/>', { size: 13, strokeWidth: 1.8 }), 'Offline-first')
      )
    )
  ))
  return h('div', null, ...body.filter(Boolean))
}

// ---- view router ----------------------------------------------------------
function onEnterView (id) {
  if (id === 'notes') refreshNotes()
  else if (id === 'clips') refreshClips()
  else if (id === 'devices') refreshDevices()
  else if (id === 'relay') refreshRelay()
  else if (id === 'settings') refreshClipboard()
}

function currentScreen () {
  switch (S.view) {
    case 'notes': return notesScreen()
    case 'clips': return clipsScreen()
    case 'search': return searchScreen()
    case 'devices': return devicesScreen()
    case 'relay': return relayScreen()
    case 'proof': return proofScreen()
    case 'settings': return settingsScreen()
    default: return notesScreen()
  }
}

// IntersectionObserver: add `.in` to `.reveal` elements as they scroll into
// view. Mirrors website/app.js — but here we scroll the `.main` container,
// not window, so root is set accordingly.
let _io = null
function setupReveal () {
  // tear down between renders (elements are replaced via mount())
  if (_io) { try { _io.disconnect() } catch (_) {} _io = null }
  const main = document.querySelector('.main')
  const reveals = Array.from(document.querySelectorAll('.reveal'))
  if (!reveals.length) return
  if (REDUCE_MOTION || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'))
    return
  }
  _io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); _io.unobserve(en.target) }
    })
  }, { root: main || null, threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
  reveals.forEach((el) => { if (!el.classList.contains('in')) _io.observe(el) })
  // First-screen content above the fold should reveal immediately so users
  // don't see a blank-then-pop on initial load.
  requestAnimationFrame(() => {
    reveals.forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.top < (window.innerHeight || 800) * 0.85) el.classList.add('in')
    })
  })
}

function render () {
  appEl.removeAttribute('aria-busy')
  // Layer any active modal AFTER the screen tree so it visually overlays.
  // Only one modal at a time (delete-note OR revoke-device).
  const modal = deleteConfirmModal() || revokeConfirmModal()
  function withModal (tree) {
    return modal ? h('div', null, tree, modal) : tree
  }
  if (S.pendingPhrase) { mount(appEl, withModal(h('div', { class: 'shell-root' }, topbar(), h('div', { class: 'main' }, phraseScreen())))) }
  else if (S.locked) { mount(appEl, withModal(h('div', { class: 'shell-root' }, topbar(), h('div', { class: 'main' }, unlockScreen())))) }
  else { mount(appEl, withModal(h('div', { class: 'shell-root' }, topbar(), shell(currentScreen())))) }
  // (re)attach reveal observer after the DOM has been swapped
  setupReveal()
}

// Esc closes whichever confirmation modal is open — safer than backdrop-click
// alone, and matches OS conventions.
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (S.deleteConfirm) { S.deleteConfirm = null; render() }
    else if (S.revokeConfirm) { S.revokeConfirm = null; render() }
  })
}

function hostPlatform () {
  const p = (navigator.platform || '').toLowerCase()
  if (p.includes('mac')) return 'macos'
  if (p.includes('win')) return 'windows'
  if (p.includes('linux')) return 'linux'
  return 'unknown'
}

// ---- tray icon (best-effort) ---------------------------------------------
// Sets a Paste-branded menubar icon if running under pear-electron. Silently
// no-ops outside that environment (e.g., browser-only smoke tests). We do NOT
// set `closeHide` — closing the window quits the app and the tray disappears
// with it, which is the expected dev behaviour. For a tray-resident daemon
// pattern, add `gui.closeHide: true` to pear.json AND opt in here.
async function setupTray () {
  if (!ui || !ui.app || typeof ui.app.tray !== 'function') return
  try {
    await ui.app.tray({
      icon: 'assets/icon-32.png',
      menu: { show: 'Show Paste', quit: 'Quit Paste' }
    })
  } catch (_) { /* tray unsupported on this OS / desktop env */ }
}

// ---- boot -----------------------------------------------------------------
// Probe lock state via a locked-allowed command (RELAY_STATUS). If the bridge
// transport is missing the catch shows a recoverable message instead of a
// blank window.
(async function start () {
  setupTray() // fire-and-forget; tray is decorative
  try {
    await bridge.relayStatus() // allowed while locked; just a reachability probe
  } catch (e) {
    if (e.code === 'NO_BRIDGE') {
      // Match the regular render path's wrapper hierarchy: .shell-root > .main >
      // .card. Without it, the fallback card centers against the viewport (not
      // the 920-px main column) and ends up clipped under the topbar's flex
      // chrome on smaller windows.
      mount(appEl, h('div', { class: 'shell-root' },
        h('div', { class: 'main' },
          h('div', { class: 'card center-card' },
            h('div', { style: 'margin-bottom: 16px' }, brandHero({ size: 'md' })),
            h('div', { class: 'banner err' }, 'Backend bridge not connected. Launch via `pear run --dev .` so the Pear-end is available.')))))
      return
    }
  }
  // We start locked; UNLOCK/CREATE/RESTORE drives the rest.
  render()
})()

// Expose a tiny hook so an automated UI harness can assert the renderer never
// holds key material (used by the e2e doc/manual steps). Reads only.
if (typeof globalThis !== 'undefined') {
  globalThis.__pasteUIState = () => JSON.parse(JSON.stringify({
    locked: S.locked, view: S.view, hasOpen: !!S.open,
    openType: S.open && S.open.type, notes: S.notes.length, clips: S.clips.length
  }))
}
