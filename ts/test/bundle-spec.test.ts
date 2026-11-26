/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The fixtures of test/bundle/: a description in several documents, and
// the one document `bundle` writes of them.
//
// Each case is a JSON file: a note, the entry document and the URI it
// was retrieved from, each other document by its URI, the options if
// any, and what `bundle` gives. That is the tree, and each row of its
// reports as a list: `embedded` rows are [at, document, from, as], `left`
// rows [at, ref, why] and `dialects` rows [at, dialect].
//
// Beside its expectation, every case is held to three things that no
// case has to say: the bundle resolves to what the documents resolve to,
// which tools/corpus/bundle-agree.cjs checks; no document is changed;
// and a bundle that is bundled again is itself. See ../../test/AGENTS.md.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as O from '../dist/openapi'
import * as U from '../dist/uri'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const ROOT = join(__dirname, '..', '..')
const DIR = join(ROOT, 'test', 'bundle')

const { agree } = require(join(ROOT, 'tools', 'corpus', 'bundle-agree.cjs'))

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

type Case = {
  note: string
  retrievalUri: string
  options?: Record<string, unknown>
  entry: unknown
  documents: Record<string, unknown>
  bundle: { tree: unknown; embedded: string[][]; left: unknown[][]; dialects: string[][] }
}

describe('bundle, from test/bundle', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()

  test('the folder holds cases, and nothing else', () => {
    assert.ok(0 < files.length, 'test/bundle has no case')
    assert.deepEqual(readdirSync(DIR).sort(), files)
  })

  for (const file of files) {
    const c: Case = JSON.parse(readFileSync(join(DIR, file), 'utf8'))
    test(`${file}: ${c.note.slice(0, 70)}`, async () => {
      const raw = O.parse(JSON.stringify(c.entry))
      const options = { retrievalUri: c.retrievalUri, documents: c.documents, ...(c.options ?? {}) }
      const before = JSON.stringify([raw, c.documents])
      const b = O.bundle(raw, options)

      assert.deepEqual(plain(b.tree), c.bundle.tree)
      // And its members are in the order the case writes them.
      assert.equal(JSON.stringify(b.tree), JSON.stringify(c.bundle.tree))
      assert.deepEqual(b.embedded.map((e) => [e.at, e.doc, e.from, e.as]), c.bundle.embedded)
      assert.deepEqual(b.left.map((l) => [l.at, l.ref, l.why]), c.bundle.left)
      assert.deepEqual(b.dialects.map((d) => [d.at, d.dialect]), c.bundle.dialects)
      assert.deepEqual(b.documents, Object.keys(c.documents).map((uri) => U.normalizeUri(U.resolveUri(c.retrievalUri, uri))))
      assert.equal(JSON.stringify([raw, c.documents]), before, 'a document was changed')

      const held = await agree(O, U, raw, options)
      assert.ok(held.ok, held.why.join('; '))

      // The bundle is a description in one document. Nothing of it is
      // elsewhere, so there is nothing to bring in.
      const { documents: _given, ...alone } = options
      const again = O.bundle(b.tree, alone)
      assert.equal(JSON.stringify(again.tree), JSON.stringify(b.tree))
      assert.deepEqual(again.embedded, [])
      assert.deepEqual(again.dialects, [])
    })
  }
})

// The fixtures of test/bundle-held/: the sets of documents that a
// generator of ts/test/bundle.test.ts failed on, each cut down to what
// fails, in a file for each thing that was wrong. A file is a note, the
// URI the entry was retrieved from, and the sets, each an entry, its
// documents and its options if any. No set says what `bundle` gives:
// each is held to what every bundle is held to. It resolves to what the
// documents resolve to, and it is its own bundle unless it lists a part
// whose type it could not keep.
describe('bundle, from test/bundle-held', () => {
  const HELD = join(ROOT, 'test', 'bundle-held')
  const files = readdirSync(HELD)
    .filter((f) => f.endsWith('.json'))
    .sort()

  test('the folder holds sets, and nothing else', () => {
    assert.ok(0 < files.length, 'test/bundle-held has no file')
    assert.deepEqual(readdirSync(HELD).sort(), files)
  })

  type Held = { note: string; retrievalUri: string; sets: { entry: unknown; documents: Record<string, unknown>; options?: Record<string, unknown> }[] }
  for (const file of files) {
    const c: Held = JSON.parse(readFileSync(join(HELD, file), 'utf8'))
    test(`${file}: ${c.note.slice(0, 70)}`, async () => {
      assert.ok(0 < c.sets.length, 'no set')
      for (const [n, set] of c.sets.entries()) {
        const raw = O.parse(JSON.stringify(set.entry))
        const options = { retrievalUri: c.retrievalUri, documents: set.documents, ...(set.options ?? {}) }
        const before = JSON.stringify([raw, set.documents])
        const held = await agree(O, U, raw, options)
        assert.ok(held.ok, `set ${n}: ${held.why.join('; ')}`)
        assert.equal(JSON.stringify([raw, set.documents]), before, `set ${n}: a document was changed`)
        if (held.bundle.left.some((l: any) => 'type' === l.why)) continue
        const { documents: _given, ...alone } = options
        const again = O.bundle(held.bundle.tree, alone)
        assert.equal(JSON.stringify(again.tree), JSON.stringify(held.bundle.tree), `set ${n}`)
        assert.deepEqual(again.embedded, [], `set ${n}`)
      }
    })
  }
})
