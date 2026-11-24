/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The fixtures of test/docs/: a description in several documents.
//
// Each case is a folder: the documents as files, and `case.json`, which
// names the entry document and the URI it was retrieved from, gives each
// other document by the URI it was retrieved from, and says what
// `resolve` makes of them: the entry's resolved tree, the references
// left as written, the cuts, and each site as
// `[its document, where, its target's document, its target, its status]`,
// a document being '' where it is the entry or the site's own. The first
// cases are the specification's own examples of several documents, as it
// writes them. See ../../test/AGENTS.md.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parse, resolve } from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const DOCS = join(__dirname, '..', '..', 'test', 'docs')

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

type Case = {
  source: string
  entry: string
  retrievalUri: string
  documents: Record<string, string>
  options?: Record<string, unknown>
  tree: unknown
  unresolved: unknown[]
  cuts: unknown[]
  sites: unknown[]
  connections?: unknown[]
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
    test(`${name}: ${c.source}`, () => {
      const read = (file: string) => readFileSync(join(dir, file), 'utf8')
      const documents: Record<string, string> = {}
      for (const [uri, file] of Object.entries(c.documents)) documents[uri] = read(file)
      const r = resolve(parse(read(c.entry)), { retrievalUri: c.retrievalUri, documents, ...(c.options ?? {}) })
      assert.deepEqual(plain(r.tree), c.tree)
      assert.deepEqual(plain(r.unresolved), c.unresolved)
      assert.deepEqual(plain(r.cuts), c.cuts)
      assert.deepEqual(
        r.provenance.map((p) => [p.doc ?? '', p.at, p.targetDoc ?? '', p.target, p.status]),
        c.sites,
      )
      if (undefined !== c.connections) assert.deepEqual(plain(r.connections), c.connections)
      // Every file of the case is one of its documents.
      const used = new Set([c.entry, ...Object.values(c.documents), 'case.json'])
      assert.deepEqual(readdirSync(dir).filter((f) => !used.has(f)), [], `files of test/docs/${name} that the case does not name`)
    })
  }
})
