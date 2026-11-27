/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The fixtures of test/load/: a description whose documents are found
// by loading, and what `resolveAll` and `bundleAll` make of it.
//
// Each case is a JSON file. `entry` is the description, `retrievalUri`
// the URI it was retrieved from, `options` the options of `resolveAll`
// if any, and `given` the documents given with it, if any. `table` is
// what the loader has, each document by its URI: a string is its text,
// `null` is a loader that answers `null`, and anything else is its tree.
// For a URI that is not in the table the loader answers nothing. `asked`
// is what the loader was asked for, in order: a loader is asked for one
// document at a time, and a text is read before the next is asked for.
//
// A case then says what `resolveAll` gives, as a case of test/docs/ says
// what `resolve` gives: `documents`, the resolved `tree`, `unresolved`,
// `cuts`, each site as `[its document, where, its target's document, its
// target, its status]`, and `connections` where the case is about one.
// Or it says `error`: the code, and where the case has them the `at` and
// the `file` the error names. `bundle` is what `bundleAll` makes of the
// same description and loader, with what it asked for: an `error`, or
// the bundle as a case of test/bundle/ has it, which is then held to
// its documents by tools/corpus/bundle-agree.cjs.
//
// `addresses.tsv` is the table of which addresses the HTTP loader takes
// for public. See ../../test/AGENTS.md.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadSpec } from '@tabnas/support'

import * as O from '../dist/openapi'
import * as U from '../dist/uri'
import { bundleAll, parse, resolveAll } from '../dist/openapi'
import { isPublicAddress } from '../dist/loaders'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const ROOT = join(__dirname, '..', '..')
const DIR = join(ROOT, 'test', 'load')
const ADDRESSES = 'addresses.tsv'

const { agree } = require(join(ROOT, 'tools', 'corpus', 'bundle-agree.cjs'))

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

type Refusal = { code: string; at?: string; file?: string }
type Case = {
  note: string
  retrievalUri: string
  entry: unknown
  options?: Record<string, unknown>
  given?: Record<string, unknown>
  table: Record<string, unknown>
  asked: string[]
  error?: Refusal
  documents?: string[]
  tree?: unknown
  unresolved?: unknown[]
  cuts?: unknown[]
  sites?: unknown[]
  connections?: unknown[]
  bundle?: {
    asked: string[]
    error?: Refusal
    documents?: string[]
    tree?: unknown
    embedded?: string[][]
    left?: unknown[][]
    dialects?: string[][]
  }
}

// A loader over a table, which says what it was asked for. It answers
// on a later turn, as a loader that reads a file or a network does, and
// fails if it is asked for a document while it has one to answer for:
// a loader is asked for one document at a time.
function loader(table: Record<string, unknown>) {
  const asked: string[] = []
  let open = 0
  const load = async (uri: string) => {
    asked.push(uri)
    assert.equal(open, 0, 'the loader was asked for ' + uri + ' before it had answered for the one before')
    open++
    await new Promise((done) => setImmediate(done))
    open--
    return Object.prototype.hasOwnProperty.call(table, uri) ? table[uri] : undefined
  }
  return { asked, load }
}

// Whether an error is the one a case says.
const refused = (want: Refusal) => (e: any) =>
  want.code === e.code && (undefined === want.at || want.at === e.at) && (undefined === want.file || want.file === e.fileName)

describe('several documents, loaded, from test/load', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()

  test('the folder holds cases and the table of addresses, and nothing else', () => {
    assert.ok(0 < files.length, 'test/load has no case')
    assert.deepEqual(readdirSync(DIR).sort(), [...files, ADDRESSES].sort())
  })

  for (const file of files) {
    const c: Case = JSON.parse(readFileSync(join(DIR, file), 'utf8'))
    test(`${file}: ${c.note.slice(0, 70)}`, async () => {
      const options = { retrievalUri: c.retrievalUri, ...(c.given ? { documents: c.given } : {}), ...(c.options ?? {}) }
      const before = JSON.stringify([c.entry, c.given, c.table])

      const first = loader(c.table)
      if (undefined !== c.error) {
        await assert.rejects(() => resolveAll(parse(JSON.stringify(c.entry)), { ...options, load: first.load }), refused(c.error))
      } else {
        const r = await resolveAll(parse(JSON.stringify(c.entry)), { ...options, load: first.load })
        assert.deepEqual(r.documents, c.documents)
        assert.deepEqual(plain(r.tree), c.tree)
        assert.deepEqual(plain(r.unresolved), c.unresolved)
        assert.deepEqual(plain(r.cuts), c.cuts)
        assert.deepEqual(
          r.provenance.map((p) => [p.doc ?? '', p.at, p.targetDoc ?? '', p.target, p.status]),
          c.sites,
        )
        if (undefined !== c.connections) assert.deepEqual(plain(r.connections), c.connections)
      }
      assert.deepEqual(first.asked, c.asked)

      if (undefined !== c.bundle) {
        const second = loader(c.table)
        if (undefined !== c.bundle.error) {
          await assert.rejects(() => bundleAll(parse(JSON.stringify(c.entry)), { ...options, load: second.load }), refused(c.bundle.error))
        } else {
          const b = await bundleAll(parse(JSON.stringify(c.entry)), { ...options, load: second.load })
          assert.deepEqual(b.documents, c.bundle.documents)
          assert.deepEqual(plain(b.tree), c.bundle.tree)
          assert.equal(JSON.stringify(b.tree), JSON.stringify(c.bundle.tree))
          assert.deepEqual(b.embedded.map((e) => [e.at, e.doc, e.from, e.as]), c.bundle.embedded)
          assert.deepEqual(b.left.map((l) => [l.at, l.ref, l.why]), c.bundle.left)
          assert.deepEqual(b.dialects.map((d) => [d.at, d.dialect]), c.bundle.dialects)
          const held = await agree(O, U, parse(JSON.stringify(c.entry)), { ...options, load: loader(c.table).load })
          assert.ok(held.ok, held.why.join('; '))
        }
        assert.deepEqual(second.asked, c.bundle.asked)
      }
      assert.equal(JSON.stringify([c.entry, c.given, c.table]), before, 'a document was changed')
    })
  }
})

describe('which addresses are public, from test/load/addresses.tsv', () => {
  const spec = loadSpec(join(DIR, ADDRESSES))

  test('the table has rows, each of them yes or no', () => {
    assert.ok(0 < spec.rows.length)
    for (const row of spec.rows) assert.ok(['yes', 'no'].includes(row.named('public')), `row ${row.line}`)
  })

  for (const row of spec.rows) {
    const address = row.named('address')
    test(`row ${row.line}: ${JSON.stringify(address)}`, () => {
      assert.equal(isPublicAddress(address), 'yes' === row.named('public'))
    })
  }
})
