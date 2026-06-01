// Paste — centralized UX copy — enforces spec §19 wording rules and §4 security promise.
//
// USE:  "Pair a device", "Restore with recovery phrase", "Relays store
//        encrypted blocks", "Run encryption verifier", "Reduced availability".
// AVOID: "Sign in with account", "Cloud sync", "Guaranteed deletion",
//        "Anonymous", "Trustless" (unless a specific proof is shown).
//
// Keeping all user-facing strings here lets the security/QA agent grep one file
// for forbidden phrasing instead of auditing every screen.

export const COPY = Object.freeze({
  appName: 'Paste',
  tagline: 'One notepad. Every device you own.',
  splashHint: 'Starting the encrypted engine…',

  unlock: {
    title: 'Unlock vault',
    secretLabel: 'Passphrase',
    button: 'Unlock',
    locked: 'Vault is locked',
    hint: 'This unlocks keys on this device only. Notes and clips stay sealed until you open one.',
    noVault: 'No vault on this device yet.',
    create: 'Create a new vault',
    restore: 'Restore with recovery phrase',
    pair: 'Pair a device'
  },

  create: {
    title: 'Create vault',
    labelField: 'Device name',
    passphraseField: 'Passphrase (optional)',
    button: 'Create vault',
    phraseTitle: 'Your recovery phrase',
    phraseWarn: 'Write these 24 words down and keep them offline. They are shown once. Anyone with this phrase can read your notes.',
    phraseConfirm: 'I have written it down'
  },

  restore: {
    title: 'Restore with recovery phrase',
    field: '24-word recovery phrase',
    passphraseField: 'Passphrase (if you set one)',
    button: 'Restore vault',
    hint: 'Restoring derives your keys on this device. If no other device or relay is reachable you can import an encrypted backup file.',
    bad: 'That recovery phrase is not valid. Check word order and spelling.'
  },

  pair: {
    title: 'Pair a device',
    scan: 'Scan pairing QR',
    enterCode: 'Or paste the invite',
    codeField: 'A1B2-C3D4   — or paste the full invite payload',
    inviteFieldHint: 'A short code starts discovery only. The unlocked device must approve the matching request before keys are released.',
    accept: 'Pair this device',
    creating: 'Show pairing invite',
    confirmPrompt: 'Check that this number matches the other device:',
    cameraDenied: 'Camera access is off. Paste the full invite text instead.',
    scanHint: 'Point at the QR shown on an unlocked device.',
    expired: 'That pairing invite expired. Create a new one on the other device.',
    paired: 'Device paired. Sync is starting.'
  },

  devices: {
    title: 'Devices',
    blurb: 'Each device signs with its own key. Revoke any at any time — keys rotate and the revoked device cannot read content that arrives after.',
    empty: 'No paired devices yet. Pair one with the button below.',
    pairAction: 'Pair a new device',
    revoke: 'Revoke',
    sealedRow: 'Sealed device record',
    revokedSuffix: 'revoked',
    // Modal confirmation strings — mirror desktop's revokeConfirm* in
    // ui/shared/copy.js so both apps say the same thing.
    revokeConfirmTitle: 'Revoke this device?',
    revokeConfirmBody: 'The device is removed from your vault. Keys are rotated so any future writes use a fresh key — the revoked device, even if it kept a local copy of vault material, cannot read or sign anything that arrives after this moment. The device must pair again to rejoin.',
    revokeConfirmAction: 'Revoke device',
    revokeSucceeded: 'Device revoked. Keys rotated; revoked device cannot read future content.'
  },

  notes: {
    title: 'Notes',
    empty: 'No notes yet.',
    sealedRow: 'Sealed — tap to decrypt',
    new: 'New note',
    // Opt-in identifier shown in the notes list so users can disambiguate
    // notes without opening each one. Encrypted at rest + over relays;
    // decrypted only on this device while the vault is unlocked.
    labelField: 'Label (shown in list)',
    labelPlaceholder: 'e.g. work, recipes',
    labelHint: 'Optional. Encrypted; only decrypted on this device while unlocked.',
    titleField: 'Title',
    bodyField: 'Note',
    save: 'Save',
    delete: 'Delete',
    pinned: 'Pinned',
    closeHint: 'Closing clears the decrypted text from memory.',
    // Hard-delete (cryptographic erasure) confirmation strings. Mirrored on
    // desktop in ui/shared/copy.js.
    deleteConfirmTitle: 'Delete this note?',
    deleteConfirmBody: 'The encrypted envelope is erased from this device, and a signed delete op replicates to your paired devices so they drop their copies too. Any ciphertext still held by a relay becomes unreadable. This cannot be undone.',
    deleteConfirmAction: 'Erase note',
    deleteSucceeded: 'Note erased. Envelope removed from this device; delete op replicating to paired devices.',
    // Temporary-note toggle. Per-note expiresAt lives inside the encrypted
    // envelope; backend sweeper emits a hard NOTE_DELETE when expiry passes.
    temporaryToggle: 'Make this note temporary',
    temporaryHint: 'A temporary note is erased after the chosen window. The hard-delete replicates to paired devices when they reconnect; relay-held ciphertext becomes unreadable.',
    temporaryTtlLabel: 'Erase after',
    temporaryExpiresPrefix: 'erases in',
    temporaryExpiredLabel: 'expired'
  },

  clips: {
    title: 'Recent clips',
    empty: 'No clips yet. Paste into the app to capture one.',
    sealedRow: 'Sealed — tap to decrypt',
    copy: 'Copy',
    paste: 'Paste from clipboard',
    pasteField: 'Paste here to capture',
    copied: 'Copied. App-held text was cleared.',
    // Honest mobile clipboard reality (spec §13).
    osNoteIOS: 'iOS does not allow background clipboard sync. Capture by pasting into Paste or using the share sheet while the app is open.',
    osNoteAndroid: 'Android limits background clipboard access. Foreground capture works while Paste is open; background sync is not promised.'
  },

  relay: {
    title: 'Relay & proof',
    directPeers: 'Direct peers',
    relaysHolding: 'Relays holding ciphertext',
    custodyQuorum: 'Custody quorum',
    lastVerifier: 'Last verifier run',
    lastRotation: 'Last key rotation',
    enabledToggle: 'Use encrypted relays',
    blurb: 'Relays store encrypted blocks only. They never receive your notes or your keys.',
    reduced: 'Reduced availability',
    runVerifier: 'Run encryption verifier',
    deletionLimit: 'This does not prove physical deletion from third-party disks.',
    // Network exposure section (Phase 1). Strings mirror desktop's
    // network* keys in ui/shared/copy.js — same wording on both apps.
    networkTitle: 'Network exposure',
    networkBlurb: 'Encryption protects your notes. It does not hide network metadata. Anyone in this list can see your IP address.',
    networkPeersHeader: 'Direct peers (see your IP)',
    networkRelaysHeader: 'Relays (see your IP + sync activity)',
    networkPeersEmpty: 'No direct peers connected right now.',
    networkRelaysEmpty: 'No relays connected right now.',
    networkViaDht: 'direct (DHT hole-punch)',
    networkViaRelayCircuit: 'via relay-circuit (peer sees a relay, not you)',
    networkViaUnknown: 'path unknown',
    networkHonestyHint: 'This is the metadata-exposure surface Paste cannot encrypt away. A future relay-only mode will let you stop talking to random peers — your IP will then only reach the operator-run relay fleet.'
  },

  errors: {
    locked: 'Vault is locked. Unlock to continue.',
    crashed: 'The sync engine stopped. Your local data is safe.',
    retry: 'Restart engine',
    generic: 'Something went wrong.',
    notFound: 'That item is no longer available.'
  }
})

// Map a backend error code to honest, non-leaky user text.
export function errorText (err) {
  const code = err && err.code
  switch (code) {
    case 'VAULT_LOCKED': return COPY.errors.locked
    case 'NOT_FOUND': return COPY.errors.notFound
    case 'BAD_MNEMONIC': return COPY.restore.bad
    case 'PAIRING_EXPIRED': return COPY.pair.expired
    case 'WORKLET_CRASHED':
    case 'WORKLET_NOT_READY':
    case 'RPC_DISCONNECTED': {
      // When MobilePearEnd has the underlying crash info, surface it inline
      // so the user (and we) see WHY the engine stopped — reason, exit code,
      // last stage, message — instead of the generic copy that hides the
      // cause. The bare "engine stopped" copy was actively making pairing
      // failures undebuggable from the UI.
      const info = err && err.crashInfo
      if (info && (info.reason || info.lastStage || info.message || info.code != null)) {
        const parts = []
        if (info.reason) parts.push(info.reason)
        if (info.code != null && info.code !== '' && info.code !== info.reason) parts.push('exit ' + info.code)
        if (info.lastStage) parts.push('last stage: ' + info.lastStage)
        if (info.message) parts.push(String(info.message).slice(0, 240))
        return 'Engine stopped — ' + parts.join(' · ')
      }
      return COPY.errors.crashed
    }
    default: return (err && err.message) || COPY.errors.generic
  }
}

export default COPY
