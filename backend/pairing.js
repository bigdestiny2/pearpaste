// Paste pairing.
//
// One-time invites, short codes, temporary expiring topics, and the sealed
// vault-bootstrap payload exchanged when an unlocked device admits a new one.
// Device authorization (signed DEVICE_ADD) and the network handshake loop are
// completed in autobase-sync.js (Agent 1); pairing UX lives in the shells
// (Agent 4 / Agent 3). This module is the shared crypto + wire-format spine.
//
// Spec refs: §14 (pairing/login), §10 (topics: pairing topics temporary,
// random, expire quickly), §7.2 (device record).

import b4a from 'b4a'
import {
  randomBytes, hash, hmac, canonicalize, CryptoError
} from './crypto-envelope.js'
import { sealToDevice, openSealedToDevice } from './identity.js'
import { ERROR_CODES } from './shared-ops.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000

// vaultDiscoveryTopic = HMAC(topicSeed, "swarm-topic-v1"), 32 bytes (spec §10).
//
// EPOCH-AWARE (REVOCATION_DESIGN §3.7.1): the argument is a topic SEED, not
// necessarily the vaultKey. Epoch-0 callers pass the raw vaultKey so the
// legacy topic is byte-identical (no flag-day, design §6). After a rotation,
// callers pass crypto.topicSeedFromEpochKey(epochKey_e) — derived LOCALLY from
// the active epoch key and never transmitted (RT-FIX B3) — so a revoked
// device, which never receives epochKey_{N+1}, cannot compute the new topic.
// NOTE (GATE SB2): topic rotation is a DISCOVERY CONVENIENCE, not an exclusion
// barrier — a revoked device can still dial the immutable Autobase core key.
// The replication firewall (replication-firewall.js) is the real control.
export function vaultDiscoveryTopic (topicSeed) {
  return hmac(topicSeed, 'swarm-topic-v1') // Buffer(32)
}

// Per-device follow/catch-up topic (REVOCATION_DESIGN §4, default-on).
// followTopic(d) = HMAC(followSeed, "follow:" + deviceId). A survivor that was
// OFFLINE during a rotation can only derive the OLD epoch topic, which the
// online survivors leave (grace 0); it would be stranded. So every device
// always joins its OWN follow topic on unlock, and for a window after each
// rotation the online survivors ANNOUNCE every other SURVIVING device's follow
// topic — the returning device finds a survivor there, replicates the
// KEY_ROTATE, unwraps its lockbox, and walks forward to the new topic. The
// revoked device's follow topic is simply never announced again. Follow topics
// are discovery-only: knowing one buys a connection, and the replication
// firewall still refuses a revoked/unknown peer on that connection.
export function followTopic (followSeed, deviceId) {
  return hmac(followSeed, 'follow:' + String(deviceId))
}

// Temporary, random pairing topic that expires (spec §10/§14).
export function newPairingTopic () {
  return randomBytes(32)
}

// Short-code rendezvous topic. The short code is discovery only: it lets a
// fresh device fetch the full invite payload. It is NOT authorization. The
// unlocked inviter must still approve the signed hello and matching
// confirmation code before any writer is admitted or any bootstrap keys are
// released.
//
// `shortCode` accepts either "A1B2C3D4" or the displayed "A1B2-C3D4" form.
const SHORTCODE_RENDEZVOUS_KEY = b4a.from('paste-shortcode-rendezvous-v1')
export function normalizeShortCode (shortCode) {
  return String(shortCode || '').replace(/[\s-]/g, '').toUpperCase()
}
export function isShortCodeShape (input) {
  const s = normalizeShortCode(input)
  return /^[0-9A-F]{8}$/.test(s)
}
export function shortCodeRendezvousTopic (shortCode) {
  const normalized = normalizeShortCode(shortCode)
  if (!/^[0-9A-F]{8}$/.test(normalized)) {
    throw new CryptoError('short code must be 8 hex chars (e.g. A1B2-C3D4)', 'BAD_SHORT_CODE')
  }
  // 32 bytes — Hyperswarm topic size. HMAC binds the code to this app's
  // namespace so unrelated Pear apps using the same 8-char code don't collide.
  return hmac(SHORTCODE_RENDEZVOUS_KEY, normalized)
}

// Build a one-time invite. `invitePub` is an ephemeral box public key the
// existing device generated for this pairing only.
//
// Wire format (compact, fits the built-in QR encoder's byte-mode v10 capacity
// of ~271 chars even with autobaseKey present): single-letter JSON keys and
// NO base64 wrapping. `decodeInvite` also accepts the legacy long-key
// base64-wrapped form so older invites still work.
//
//   compact: {"v":1,"t":"<topicHex>","p":"<invitePubkeyHex>","e":<expiresAtMs>,
//             "a":"<autobaseKeyHex>","r":[...relayHints],"s":"<swarmPubkeyHex>"}
//   legacy:  base64( JSON({version:1, topic, invitePubkey, expiresAt, autobaseKey?, relayHints, swarmPubkey?}) )
//
// `swarmPubkey` (hex of ctx.swarm.keyPair.publicKey) + `relayHints` (hex
// pubkeys of HiveRelays the inviter is connected to) enable the joining
// device to fall back to a circuit-relay rendezvous when DHT/UDX hole-punch
// fails. Both are optional and receivers degrade to DHT-only when absent.
// QR-encoder budget: byte-mode v17 ≈ 511 chars with M ECC ≈ ~30% redundancy,
// scannable by an average phone camera at 320 px QR size in good light. We
// trim relayHints from the END if the payload would exceed this; the joiner
// still tries ALL its connected circuit-capable relays as fallback
// (relay-service.js circuitConnect), so trimming hints is safe.
const QR_MAX_INVITE_CHARS = 500

export function createInvite ({ topic, invitePubkey, relayHints = [], ttlMs = DEFAULT_TTL_MS, autobaseKey = null, swarmPubkey = null }) {
  const expiresAt = Date.now() + ttlMs
  const payload = {
    v: 1,
    t: b4a.toString(topic, 'hex'),
    p: invitePubkey,
    e: expiresAt
  }
  if (autobaseKey) payload.a = autobaseKey
  if (swarmPubkey) payload.s = swarmPubkey
  // Add relayHints last so we can trim them if the payload runs over budget.
  const hints = Array.isArray(relayHints) ? relayHints.slice() : []
  payload.r = hints
  let serialized = JSON.stringify(payload)
  while (serialized.length > QR_MAX_INVITE_CHARS && hints.length > 0) {
    hints.pop() // drop the lowest-priority hint
    serialized = JSON.stringify(payload)
  }
  if (hints.length === 0) delete payload.r
  serialized = JSON.stringify(payload)
  const code = b4a.toString(randomBytes(4), 'hex').toUpperCase() // human short code
  return {
    invite: serialized,
    shortCode: code.match(/.{1,4}/g).join('-'),
    expiresAt
  }
}

export function decodeInvite (invite) {
  const raw = String(invite || '').trim()
  // Friendlier errors for the three common UI mistakes:
  //   - Empty input
  //   - Pasting the 8-char "short code" (e.g. "A1B2-C3D4") into the invite
  //     field (the short code is a human verification token, NOT the invite)
  //   - QR scan returned partial/garbled data (rare with our 271-char cap)
  if (!raw) throw new CryptoError('paste the pairing invite first', 'BAD_INVITE')
  // Short-code shape: 4-12 chars, [A-Z0-9-]. Pair accept resolves short codes
  // through PAIR_LOOKUP_SHORTCODE first; decodeInvite only accepts full
  // invite payloads.
  if (/^[A-Z0-9-]{4,12}$/.test(raw)) {
    throw new CryptoError(
      'that looks like a short code — resolve it first or paste the full invite text instead',
      'BAD_INVITE'
    )
  }
  let payload = null
  // 1) Compact form: a JSON object starting with `{`.
  if (raw.startsWith('{')) {
    try { payload = JSON.parse(raw) } catch (_) {
      // Started like JSON but failed to parse — almost certainly a partial
      // QR scan (camera dropped some characters in the byte-mode payload).
      throw new CryptoError('invite was truncated — please scan the QR again with the phone held steady', 'BAD_INVITE')
    }
    if (payload && payload.v === 1 && typeof payload.t === 'string') {
      return _normalizeInvite({
        version: payload.v,
        topic: payload.t,
        invitePubkey: payload.p,
        autobaseKey: payload.a || null,
        relayHints: payload.r || [],
        swarmPubkey: payload.s || null,
        expiresAt: payload.e
      })
    }
    throw new CryptoError('invite payload is missing required fields', 'BAD_INVITE')
  }
  // 2) Legacy form: base64 of long-key JSON.
  try {
    payload = JSON.parse(b4a.toString(b4a.from(raw, 'base64')))
  } catch (_) {
    throw new CryptoError(
      'invite is malformed — scan the QR shown on the other device, or paste the full invite text (not the short code)',
      'BAD_INVITE'
    )
  }
  if (!payload || payload.v !== 1) throw new CryptoError('unsupported invite version', 'BAD_INVITE')
  return _normalizeInvite(payload)
}

function _normalizeInvite (payload) {
  if (Date.now() > payload.expiresAt) {
    throw new CryptoError('pairing invite expired', ERROR_CODES.PAIRING_EXPIRED)
  }
  return {
    topic: b4a.from(payload.topic, 'hex'),
    invitePubkey: payload.invitePubkey,
    autobaseKey: payload.autobaseKey || null,
    relayHints: payload.relayHints || [],
    swarmPubkey: payload.swarmPubkey || null,
    expiresAt: payload.expiresAt
  }
}

export function assertInviteOpen (invite) {
  if (!invite) throw new CryptoError('pairing invite missing', 'BAD_INVITE')
  if (Date.now() > invite.expiresAt) {
    throw new CryptoError('pairing invite expired', ERROR_CODES.PAIRING_EXPIRED)
  }
  return true
}

export function helloProofPayload (hello) {
  return {
    v: 1,
    t: 'pp-pair-hello',
    invitePubkey: String(hello.invitePubkey || ''),
    expiresAt: String(hello.expiresAt || ''),
    deviceId: String(hello.deviceId || ''),
    label: String(hello.label || ''),
    platform: String(hello.platform || ''),
    signingPubkey: String(hello.signingPubkey || ''),
    boxPubkey: String(hello.boxPubkey || ''),
    writerKey: String(hello.writerKey || ''),
    roles: Array.isArray(hello.roles) ? hello.roles.map(String).sort() : []
  }
}

// Short numeric/word confirmation derived from both sides of the handshake so
// the user can compare it on two screens (spec §14 step 5).
export function confirmationPhrase (handshakeSecret) {
  const h = hash('pair-confirm:' + b4a.toString(b4a.from(handshakeSecret), 'hex'), 16)
  const n = (h[0] << 16) | (h[1] << 8) | h[2]
  return String(n % 1_000_000).padStart(6, '0')
}

export function confirmationPhraseForHello (hello) {
  return confirmationPhrase(hash(canonicalize(helloProofPayload(hello))))
}

// The existing device builds the encrypted vault bootstrap and seals it to the
// new device's box public key (spec §14 step 6).
export function sealBootstrap ({ recipientBoxPubkey, bootstrap }) {
  const bytes = canonicalize(bootstrap)
  return sealToDevice(recipientBoxPubkey, b4a.from(bytes))
}

export function openBootstrap ({ boxPubkey, boxSecretKey, sealed }) {
  const bytes = openSealedToDevice(boxPubkey, boxSecretKey, sealed)
  return JSON.parse(b4a.toString(bytes))
}

export default {
  vaultDiscoveryTopic,
  followTopic,
  newPairingTopic,
  shortCodeRendezvousTopic,
  normalizeShortCode,
  isShortCodeShape,
  createInvite,
  decodeInvite,
  assertInviteOpen,
  helloProofPayload,
  confirmationPhrase,
  confirmationPhraseForHello,
  sealBootstrap,
  openBootstrap
}
