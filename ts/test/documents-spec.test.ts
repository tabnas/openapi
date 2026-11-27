/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The fixtures of test/docs/: a description in several documents.
//
// Each case is a folder: the documents as files, and `case.json`, which
// names the entry document and the URI it was retrieved from, gives each
// other document by the URI it was retrieved from, and says what
// `resolve` makes of them: the entry's resolved tree, the references
// left as written, the cuts, and each site as
// `[its document, where, its target's document, its target, its status]`,
// a document being '' where it is the entry or the site's own. `bundle`
// is what `bundle` writes of them as one document, in the form a case of
// test/bundle/ has it. A case may give `options`, which `resolve` and
// `bundle` both take, and `resolveOptions`, which `resolve` alone takes:
// the shape of the resolved tree is nothing `bundle` reads. It may also
// say the `connections` and the `urls` of the result, each row as the
// report has it. The first cases are the specification's own examples
// of several documents, as it writes them. See ../../test/AGENTS.md.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import * as O from '../dist/openapi'
import * as U from '../dist/uri'
import { bundle, parse, resolve } from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const ROOT = join(__dirname, '..', '..')
const DOCS = join(ROOT, 'test', 'docs')

// Whether a bundle resolves to what its documents resolve to.
const { agree } = require(join(ROOT, 'tools', 'corpus', 'bundle-agree.cjs'))

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

type Case = {
  source: string
  entry: string
  retrievalUri: string
  documents: Record<string, string>
  options?: Record<string, unknown>
  resolveOptions?: Record<string, unknown>
  tree: unknown
  unresolved: unknown[]
  cuts: unknown[]
  sites: unknown[]
  connections?: unknown[]
  urls?: unknown[]
  bundle: { tree: unknown; embedded: string[][]; left: unknown[][]; dialects: string[][] }
}

describe('several documents, from test/docs', () => {
  const folders = readdirSync(DOCS)
    .filter((name) => statSync(join(DOCS, name)).isDirectory())
    .sort()

  test('the folder holds cases, and every folder in it is one', () => {
    assert.ok(0 < folders.length, 'test/docs has no case')
    for (const name of folders) assert.ok(existsSync(join(DOCS, name, 'case.json')), `test/docs/${name} has no case.json`)
  })

  for (const name of folders) {
    const dir = join(DOCS, name)
    if (!existsSync(join(dir, 'case.json'))) continue
    const c: Case = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'))
    test(`${name}: ${c.source}`, async () => {
      const read = (file: string) => readFileSync(join(dir, file), 'utf8')
      const documents: Record<string, string> = {}
      for (const [uri, file] of Object.entries(c.documents)) documents[uri] = read(file)
      const r = resolve(parse(read(c.entry)), { retrievalUri: c.retrievalUri, documents, ...(c.options ?? {}), ...(c.resolveOptions ?? {}) })
      assert.deepEqual(plain(r.tree), c.tree)
      assert.deepEqual(plain(r.unresolved), c.unresolved)
      assert.deepEqual(plain(r.cuts), c.cuts)
      assert.deepEqual(
        r.provenance.map((p) => [p.doc ?? '', p.at, p.targetDoc ?? '', p.target, p.status]),
        c.sites,
      )
      if (undefined !== c.connections) assert.deepEqual(plain(r.connections), c.connections)
      if (undefined !== c.urls) assert.deepEqual(plain(r.urls), c.urls)

      // The same documents as one, which resolves to the same.
      const options = { retrievalUri: c.retrievalUri, documents, ...(c.options ?? {}) }
      const b = bundle(parse(read(c.entry)), options)
      assert.deepEqual(plain(b.tree), c.bundle.tree)
      assert.equal(JSON.stringify(b.tree), JSON.stringify(c.bundle.tree))
      assert.deepEqual(b.embedded.map((e) => [e.at, e.doc, e.from, e.as]), c.bundle.embedded)
      assert.deepEqual(b.left.map((l) => [l.at, l.ref, l.why]), c.bundle.left)
      assert.deepEqual(b.dialects.map((d) => [d.at, d.dialect]), c.bundle.dialects)
      const held = await agree(O, U, parse(read(c.entry)), options)
      assert.ok(held.ok, held.why.join('; '))

      // Every file of the case is one of its documents.
      const used = new Set([c.entry, ...Object.values(c.documents), 'case.json'])
      assert.deepEqual(readdirSync(dir).filter((f) => !used.has(f)), [], `files of test/docs/${name} that the case does not name`)
    })
  }
})
