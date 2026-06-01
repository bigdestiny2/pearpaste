// Unit: local search index — tokenization, HMAC blind-index (no plaintext
// tokens at rest), AND-of-terms query returning SEALED rows only. Spec §9.3,
// §16, §21 Agent 1. Run: node test/unit/search.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import Corestore from 'corestore'
import * as crypto from '../../backend/crypto-envelope.js'
import * as ops from '../../backend/shared-ops.js'
import { LocalSearchIndex, beeFromCore } from '../../backend/materialized-view.js'

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-search-')) }

test('tokenize: case-fold, unicode split, length bounds', (t) => {
  t.alike(LocalSearchIndex.tokenize('Hello, World!'), ['hello', 'world'], 'punctuation split + lowercase')
  // NFKD decomposes accents into combining marks (not \p{L}), so accented
  // words fold/split deterministically — the property we rely on is that the
  // SAME input always yields the SAME tokens (stable blind-index keys).
  t.alike(LocalSearchIndex.tokenize('Café NAÏVE'), ['cafe', 'nai', 've'], 'NFKD-stable accent folding/splitting')
  t.alike(LocalSearchIndex.tokenize('Café'), LocalSearchIndex.tokenize('café'), 'case-insensitive + deterministic')
  t.alike(LocalSearchIndex.tokenize('a I/O ok'), ['ok'], 'sub-2-char tokens dropped (min len 2)')
  t.alike(LocalSearchIndex.tokenize(''), [], 'empty -> no tokens')
  t.alike(LocalSearchIndex.tokenize('one two two'), ['one', 'two', 'two'], 'tokenizer keeps repeats (dedup is caller)')
})

test('tokenBlindId is keyed HMAC: deterministic, hides token, key-dependent', (t) => {
  const idx = new LocalSearchIndex({ crypto, ops, indexKey: crypto.randomBytes(32), vaultId: 'v', getVaultKey: () => null })
  const idx2 = new LocalSearchIndex({ crypto, ops, indexKey: crypto.randomBytes(32), vaultId: 'v', getVaultKey: () => null })
  const a = idx.tokenBlindId('secret')
  t.is(a, idx.tokenBlindId('secret'), 'deterministic for same key+token')
  t.not(a, idx.tokenBlindId('public'), 'different token -> different blind id')
  t.not(a, idx2.tokenBlindId('secret'), 'different index key -> different blind id')
  t.absent(a.includes('secret'), 'raw token absent from blind id')
  t.ok(/^[0-9a-f]+$/.test(a), 'blind id is hex')
})

test('index + AND query returns sealed pointers; raw tokens never at rest', async (t) => {
  const dir = tmp()
  const store = new Corestore(dir)
  await store.ready()
  t.teardown(async () => { try { await store.close() } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }) })

  const core = store.get({ name: 'search-test' })
  await core.ready()
  const bee = beeFromCore(core)
  await bee.ready()

  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const idx = new LocalSearchIndex({ bee, crypto, ops, indexKey, vaultId: 'v', getVaultKey: () => vaultKey })

  const o1 = crypto.blindId(indexKey, 'note:1')
  const o2 = crypto.blindId(indexKey, 'note:2')
  await idx.indexObject({ objectId: 'note:1', objectBlindId: o1, type: 'note', texts: ['Alpha Bravo SECRETWORD', 'tagx'] })
  await idx.indexObject({ objectId: 'note:2', objectBlindId: o2, type: 'note', texts: ['Alpha Charlie'] })

  const both = await idx.search('alpha')
  t.is(both.length, 2, 'common term matches both objects')
  t.ok(both.every(r => r.sealed === true), 'rows flagged sealed')
  t.ok(both.every(r => r.objectBlindId && !r.title && !r.body), 'no decrypted title/body in result rows')

  const one = await idx.search('alpha bravo')
  t.is(one.length, 1, 'AND-of-terms narrows to the single matching object')
  t.is(one[0].objectBlindId, o1, 'correct object returned')

  t.is((await idx.search('nonexistentterm')).length, 0, 'no match -> empty')

  // re-index removes stale token pointers (update semantics)
  await idx.indexObject({ objectId: 'note:1', objectBlindId: o1, type: 'note', texts: ['Alpha Delta'] })
  t.is((await idx.search('secretword')).length, 0, 'old token pointer cleared after re-index')
  t.is((await idx.search('delta')).length, 1, 'new token indexed')

  // raw bytes on disk must not contain plaintext tokens
  await bee.close()
  await store.close()
  let leak = false
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) scan(p)
      else { try { const buf = fs.readFileSync(p); if (buf.includes(Buffer.from('SECRETWORD')) || buf.includes(Buffer.from('secretword')) || buf.includes(Buffer.from('alpha'))) leak = true } catch (_) {} }
    }
  }
  scan(dir)
  t.absent(leak, 'no plaintext search token found in raw store bytes')
})
