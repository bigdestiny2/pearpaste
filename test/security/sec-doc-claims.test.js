// Security doc-lint (REVOCATION_DESIGN §8 Phase 6, RT-FIX L8).
//
// The red team found the user-facing security docs OVERCLAIMED what
// revocation does ("bumps the content-key epoch" as the only effect, the
// revoked device "cannot rejoin the rendezvous" / "cannot obtain the bytes",
// writer eviction "is a documented no-op"). The implementation made the
// guarantee real (forward secrecy of content) but ALSO made the residuals
// explicit (L1–L8). This lint pins both directions on the three normative
// security docs: stale overclaims must never reappear, and the load-bearing
// honesty statements must never silently disappear in an edit.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const docs = (name) => fs.readFileSync(path.join(here, '..', '..', 'docs', name), 'utf8')

const SECURITY = docs('SECURITY.md')
const THREAT = docs('THREAT_MODEL.md')
const PAIRING = docs('PAIRING.md')
const DESIGN = docs('REVOCATION_DESIGN.md')

// Stale claims the red team falsified. NONE may appear in the normative
// user-facing security docs. (REVOCATION_DESIGN.md is exempt: it quotes the
// falsified claims as findings, with the corrections alongside.)
const FORBIDDEN = [
  /documented no-op/i, // removeWriter is real on Autobase 7.28.1 (host-side, liveness-gated)
  /a no-op in this build/i,
  /does not expose\s+`?addWriter/i,
  /bumps? the content-key epoch/i, // rotation is REAL key rotation, not a counter bump
  /epoch by one/i,
  /cannot rejoin the rendezvous/i, // topic rotation is a discovery convenience, not exclusion
  /cannot obtain the bytes/i, // replication of opaque ciphertext continues off-edge (L2)
  /14-day/i // the bounded-exposure-window claim died with B13
]

test('doc-lint: no falsified revocation claim survives in SECURITY/THREAT_MODEL/PAIRING', (t) => {
  for (const [name, body] of [['SECURITY.md', SECURITY], ['THREAT_MODEL.md', THREAT], ['PAIRING.md', PAIRING]]) {
    for (const re of FORBIDDEN) {
      t.absent(re.test(body), name + ' does not claim ' + String(re))
    }
  }
})

test('doc-lint: the load-bearing honesty statements are present', (t) => {
  // SECURITY.md §4.2 — the one-line promise + the three big residuals.
  t.ok(/does NOT make the device forget/i.test(SECURITY),
    'SECURITY.md states the honest one-line promise (no past-erasure)')
  t.ok(/cannot decrypt/i.test(SECURITY),
    'SECURITY.md states the forward-secrecy guarantee in decrypt terms')
  t.ok(/replicat\w+ of opaque ciphertext continues/i.test(SECURITY),
    'SECURITY.md states the L2 replication residual')
  t.ok(/(needs?|requires?)\s+a\s+new\s+vault/i.test(SECURITY),
    'SECURITY.md states the phrase-compromise boundary (new vault, not revocation)')
  // THREAT_MODEL.md §2.3 — enforced-vs-residual stays honest.
  t.ok(/cannot decrypt/i.test(THREAT), 'THREAT_MODEL.md keeps the decrypt-bound guarantee')
  t.ok(/traffic-analyze/i.test(THREAT), 'THREAT_MODEL.md keeps the metadata residual')
  t.ok(/forward,\s*\n?\s*not retroactive/i.test(THREAT), 'THREAT_MODEL.md keeps forward-not-retroactive')
  // PAIRING.md — selective-chain default + its honest epoch-0 consequence.
  t.ok(/grantHistory/.test(PAIRING), 'PAIRING.md documents the explicit grantHistory escape hatch')
  t.ok(/[Ss]elective chain/.test(PAIRING), 'PAIRING.md documents selective-chain-by-default')
  t.ok(/epoch-0 content/i.test(PAIRING), 'PAIRING.md states the epoch-0/vaultKey consequence honestly')
  // The design doc records what was PROVEN vs designed.
  t.ok(/## Appendix A/.test(DESIGN), 'REVOCATION_DESIGN.md carries the implementation-outcome appendix')
  t.ok(/SB1/.test(DESIGN) && /SB2/.test(DESIGN), 'the appendix records both GATE findings')
})
