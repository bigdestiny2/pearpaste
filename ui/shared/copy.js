// Paste UX copy (spec §19). Single source of user-facing strings so the
// banned phrases ("Sign in", "Cloud sync", "Guaranteed deletion", "Anonymous",
// bare "Trustless") never reach the screen and the required phrasing
// ("Pair a device", "Restore with recovery phrase", "Relays store encrypted
// blocks", "Run encryption verifier", "Reduced availability") stays consistent.

export const COPY = Object.freeze({
  appName: 'Paste',
  tagline: 'One notepad. Every device you own.',

  // vault lifecycle
  unlockTitle: 'Unlock your vault',
  unlockHint: 'Enter your passphrase to unlock this device. No account, no server.',
  unlockAction: 'Unlock',
  lockAction: 'Lock vault',
  createTitle: 'Create a new vault',
  createHint: 'This makes a local encrypted vault on this device. You will see a 24-word recovery phrase once.',
  createAction: 'Create vault',
  restoreTitle: 'Restore with recovery phrase',
  restoreHint: 'Enter your 24-word recovery phrase to restore this vault on a new device.',
  restoreAction: 'Restore vault',

  // recovery phrase one-time screen
  phraseTitle: 'Write down your recovery phrase',
  phraseWarn: 'This phrase is shown once and is never stored by the app. Anyone with it can read your vault. Keep it offline and safe.',
  phraseConfirm: 'I have written down my recovery phrase',
  phraseContinue: 'Continue',

  // notes / clips
  notesTitle: 'Notes',
  notesEmpty: 'No notes yet. Create one — your body text is sealed until you open it.',
  clipsTitle: 'Recent clips',
  clipsEmpty: 'No clips yet. Copy something with monitor mode on, or capture manually.',
  sealedRow: 'Sealed — tap to decrypt',
  // Optional opt-in identifier shown in the notes list so users can tell
  // notes apart without opening each one. The value lives inside the
  // encrypted envelope (no plaintext on disk, no plaintext to relays);
  // it is decrypted on this device only while the vault is unlocked.
  labelField: 'Label (shown in list)',
  labelPlaceholder: 'e.g. work, recipes, drafts',
  labelHint: 'Optional. Helps you find this note without opening it. Stored encrypted; decrypted locally only while the vault is unlocked.',
  newNote: 'New note',
  saveNote: 'Save note',
  deleteNote: 'Delete note',
  // Hard delete (cryptographic erasure). The encrypted envelope is removed
  // from this device's store, and the delete op replicates so paired devices
  // drop their copies too. Relays serving stale ciphertext are unreadable
  // (no key material persists). Irreversible — confirm before invoking.
  deleteConfirmTitle: 'Delete this note?',
  deleteConfirmBody: 'The encrypted envelope is erased from this device, and a signed delete op replicates to your paired devices so they drop their copies too. Any ciphertext still held by a relay becomes unreadable. This cannot be undone.',
  deleteConfirmAction: 'Erase note',
  deleteSucceeded: 'Note erased. Envelope removed from this device; delete op replicating to paired devices.',
  // Temporary-note toggle (per-note TTL). Persistent by default; flipping
  // the toggle on stages an expiresAt that the backend sweeper hard-deletes
  // (cryptographic erasure) the moment it fires. Default 72h, options below.
  // The label/copy stays neutral so it doesn't promise "guaranteed deletion"
  // (banned phrase — see assertCopyClean): expiry is best-effort across
  // paired devices and relays, not a third-party-disk guarantee.
  temporaryToggle: 'Make this note temporary',
  temporaryHint: 'A temporary note is erased after the chosen window. The hard-delete replicates to paired devices when they reconnect; relay-held ciphertext becomes unreadable.',
  temporaryTtlLabel: 'Erase after',
  temporaryExpiresPrefix: 'erases in',
  temporaryExpiredLabel: 'expired',
  closeItem: 'Close',
  copyClip: 'Copy to clipboard',
  copiedCleared: 'Copied. Plaintext cleared from the app.',

  // search
  searchPlaceholder: 'Search notes and clips…',
  searchEmpty: 'No matches. Results are sealed until you open one.',

  // devices / pairing
  devicesTitle: 'Devices',
  pairAction: 'Pair a device',
  pairTitle: 'Pair a device',
  pairHint: 'Scan this QR code or enter the short code on the new device. Approve the matching request here before keys are released.',
  pairShortCode: 'Short code',
  pairExpires: 'Expires',
  pairAccepting: 'Enter an invite or short code from another device to join its vault.',
  pairAcceptAction: 'Join vault',
  revokeAction: 'Revoke',
  revokeConfirm: 'Revoke this device? Future content uses rotated keys it cannot read.',
  // Modal-form revoke confirmation (replaces the native confirm()). Mirrors
  // the verifiable-delete modal: explicit title, body explaining what the
  // revoke actually does (key rotation), danger + cancel buttons.
  revokeConfirmTitle: 'Revoke this device?',
  revokeConfirmBody: 'The device is removed from your vault. Keys are rotated so any future writes use a fresh key — the revoked device, even if it kept a local copy of vault material, cannot read or sign anything that arrives after this moment. This cannot be undone (the device must pair again to rejoin).',
  revokeConfirmAction: 'Revoke device',
  revokeSucceeded: 'Device revoked. Keys rotated; revoked device cannot read future content.',

  // relay status (spec §11/§19 — "Relays store encrypted blocks")
  relayTitle: 'Relay status',
  relayBlurb: 'Relays store encrypted blocks so your notes stay available when every device is asleep. Relays never receive plaintext or keys.',
  relayDirectPeers: 'Direct peers',
  relayHolding: 'Relays holding ciphertext',
  relayQuorum: 'Custody quorum',
  relayLastVerifier: 'Last verifier run',
  relayLastRotation: 'Last key rotation',
  relayReduced: 'Reduced availability',
  relayEnabledLabel: 'Use encrypted relays',

  // encryption proof (spec §8.4)
  proofTitle: 'Encryption proof',
  proofRun: 'Run encryption verifier',
  proofBlurb: 'Paste ships local verifiers so you can inspect that plaintext never leaves this device.',

  // Network exposure — Phase 1 of the network-privacy work. Honest
  // disclosure of who can see this device's IP + connection activity right
  // now. Pairs with the website honesty section: "Not anonymous — peers and
  // relays can learn network metadata." Showing it makes the gap visible
  // instead of buried in marketing copy.
  networkTitle: 'Network exposure',
  networkBlurb: 'Encryption protects your notes. It does not hide network metadata. Anyone in this list can see your IP address.',
  networkPeersHeader: 'Direct peers (see your IP)',
  networkRelaysHeader: 'Relays (see your IP + sync activity)',
  networkPeersEmpty: 'No direct peers connected right now.',
  networkRelaysEmpty: 'No relays connected right now.',
  networkSummaryPrefix: 'Your IP is currently visible to ',
  networkSummaryPeer: 'paired device',
  networkSummaryPeers: 'paired devices',
  networkSummaryRelay: 'relay',
  networkSummaryRelays: 'relays',
  networkViaDht: 'direct (DHT hole-punch)',
  networkViaRelayCircuit: 'via relay-circuit (peer sees a relay, not you)',
  networkViaUnknown: 'path unknown',
  networkHonestyHint: 'This is the metadata-exposure surface Paste cannot encrypt away. A future "relay-only" mode will let you stop talking to random peers — your IP will only reach the operator-run relay fleet you can audit on the Devices screen.',

  // settings
  settingsTitle: 'Settings',
  settingClipMode: 'Clipboard capture',
  settingClipModeManual: 'Manual capture only',
  settingClipModeMonitor: 'Monitor clipboard',
  settingClipPause: 'Pause clipboard capture',
  settingVisibility: 'Auto-close opened items after',
  settingExclusions: 'Clipboard exclusion patterns (one regex per line)',
  captureNow: 'Capture clipboard now',

  // generic
  cancel: 'Cancel',
  errorPrefix: 'Something went wrong: '
})

// Defensive guard: assert no banned phrase slipped in. Used by the e2e test.
const BANNED = [
  /\bsign in\b/i,
  /\bcloud sync\b/i,
  /guaranteed deletion/i,
  /\banonymous\b/i
]
export function assertCopyClean (obj = COPY) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') continue
    for (const re of BANNED) {
      if (re.test(v)) throw new Error('banned UX phrase in COPY.' + k + ': ' + v)
    }
  }
  return true
}

export default COPY
