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
