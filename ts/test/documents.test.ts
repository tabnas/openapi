/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A description in several documents: `resolve` with `documents`.
//
// What the index says of a set of documents is in site-index.test.ts.
// This holds what `resolve` makes of it: the tree, what is shared, the
// cycles, and the reports. The specification's own examples of several
// documents are the fixtures of test/docs/.

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { parse, resolve, ResolveError } from '../dist/openapi'

const HERE = 'https://example.com/api/openapi.yaml'
const at = (name: string) => new URL(name, HERE).href

// A value as plain JSON: maps with no prototype compare unequal to
// literals otherwise.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

const entry = (schemas: Record<string, unknown>, version = '3.1.0') => ({
  openapi: version,
  info: { title: 'entry', version: '1' },
  paths: {},
  components: { schemas },
})

describe('several documents', () => {
  test('a reference resolves into a document given with the description', () => {
    const shared = {
      openapi: '3.1.0',
      info: { title: 'shared', version: '1' },
      components: { schemas: { Pet: { type: 'object', properties: { owner: { $ref: '#/components/schemas/Owner' } } }, Owner: { type: 'string' } } },
    }
    const r = resolve(entry({ Pet: { $ref: 'shared.yaml#/components/schemas/Pet' }, Again: { $ref: './shared.yaml#/components/schemas/Pet' } }), {
      retrievalUri: HERE,
      documents: { 'shared.yaml': shared },
    })
    assert.deepEqual(plain(r.tree.components.schemas.Pet), { type: 'object', properties: { owner: { type: 'string' } } })
    // Two references to one location hold one value, wherever it is.
    assert.equal(r.tree.components.schemas.Pet, r.tree.components.schemas.Again)
    assert.deepEqual(r.unresolved, [])
    assert.deepEqual(
      r.provenance.map((p) => [p.doc ?? '', p.at, p.targetDoc ?? '', p.target, p.status]),
      [
        ['', '/components/schemas/Pet', at('shared.yaml'), '/components/schemas/Pet', 'resolved'],
        [at('shared.yaml'), '/components/schemas/Pet/properties/owner', '', '/components/schemas/Owner', 'resolved'],
        ['', '/components/schemas/Again', at('shared.yaml'), '/components/schemas/Pet', 'resolved'],
      ],
    )
    // The documents given are not changed.
    assert.deepEqual(shared.components.schemas.Pet.properties.owner, { $ref: '#/components/schemas/Owner' })
  })

  test('a document is given as a tree, as text or as bytes', () => {
    const text = 'type: object\nproperties:\n  name: {type: string}\n'
    const want = { type: 'object', properties: { name: { type: 'string' } } }
    for (const doc of [parse(text), text, new TextEncoder().encode(text), JSON.stringify(want)]) {
      const r = resolve(entry({ Pet: { $ref: 'Pet.yaml' } }), { retrievalUri: HERE, documents: { 'Pet.yaml': doc } })
      assert.deepEqual(plain(r.tree.components.schemas.Pet), want)
    }
    // A text is read as `parse` is told to read it.
    const yes = (options: object) =>
      resolve(entry({ Flag: { $ref: 'flag.yaml' } }), { retrievalUri: HERE, documents: { 'flag.yaml': 'default: yes\n' }, ...options }).tree
        .components.schemas.Flag.default
    assert.equal(yes({}), true)
    assert.equal(yes({ parse: { reading: 'spec' } }), 'yes')
  })

  test('a document that was not given is another document still', () => {
    const r = resolve(entry({ Pet: { $ref: 'missing.yaml#/Pet' }, Here: { $ref: 'shared.yaml' } }), {
      retrievalUri: HERE,
      documents: { 'shared.yaml': { type: 'string' } },
    })
    assert.deepEqual(plain(r.tree.components.schemas), { Pet: { $ref: 'missing.yaml#/Pet' }, Here: { type: 'string' } })
    assert.deepEqual(r.unresolved, [{ at: '/components/schemas/Pet', ref: 'missing.yaml#/Pet', why: 'external' }])
    const row = r.provenance[0]
    assert.equal(row.uri, at('missing.yaml'))
    assert.equal(row.fragment, '/Pet')
    assert.throws(
      () => resolve(entry({ Pet: { $ref: 'missing.yaml#/Pet' } }), { retrievalUri: HERE, documents: {}, strict: true }),
      (e: any) => e instanceof ResolveError && 'openapi_unresolved' === e.code,
    )
  })

  test('what a document cannot be given as is refused', () => {
    const doc = entry({ Pet: { $ref: 'Pet.yaml' } })
    assert.throws(() => resolve(doc, { documents: { 'Pet.yaml': {} } }), /relative, and no retrievalUri/)
    assert.throws(() => resolve(doc, { retrievalUri: HERE, documents: { 'Pet.yaml': {}, './Pet.yaml': {} } }), /is a document already/)
    assert.throws(() => resolve(doc, { retrievalUri: HERE, documents: { 'openapi.yaml': {} } }), /is a document already/)
    assert.throws(() => resolve(doc, { retrievalUri: HERE, documents: [] as any }), TypeError)
    assert.throws(() => resolve(doc, { retrievalUri: HERE, documents: { 'Pet.yaml': {} }, refs: 'pointer' }), /refs: 'uri'/)
    assert.throws(() => resolve(doc, { retrievalUri: HERE, documents: { 'Pet.yaml': {} }, compat: 'apidef' }), /refs: 'uri'/)
    // An absolute name needs no retrieval URI.
    const r = resolve(entry({ Pet: { $ref: 'https://example.com/schemas/pet' } }), {
      documents: { 'https://example.com/schemas/pet': { type: 'string' } },
    })
    assert.deepEqual(plain(r.tree.components.schemas.Pet), { type: 'string' })
  })

  test('a cycle through two documents is cut once, and kept as a graph when asked', () => {
    const a = entry({ Node: { type: 'object', properties: { next: { $ref: 'b.yaml#/components/schemas/Node' } } } })
    const b = {
      openapi: '3.1.0',
      info: { title: 'b', version: '1' },
      components: { schemas: { Node: { type: 'object', properties: { back: { $ref: 'openapi.yaml#/components/schemas/Node' } } } } },
    }
    const options = { retrievalUri: HERE, documents: { 'b.yaml': b } }
    const cut = resolve(a, options)
    assert.deepEqual(plain(cut.tree.components.schemas.Node), {
      type: 'object',
      properties: { next: { type: 'object', properties: { back: { $ref: 'openapi.yaml#/components/schemas/Node' } } } },
    })
    assert.deepEqual(cut.cuts, [
      { at: '/components/schemas/Node/properties/back', ref: 'openapi.yaml#/components/schemas/Node', target: '/components/schemas/Node', doc: at('b.yaml'), targetDoc: HERE },
    ])
    assert.deepEqual(cut.unresolved, [])

    const kept = resolve(a, { ...options, cycles: 'keep' })
    const node = kept.tree.components.schemas.Node
    assert.equal(node.properties.next.properties.back, node)
    assert.deepEqual(kept.cuts, [])
    assert.deepEqual(kept.provenance.map((p) => p.status), ['resolved', 'resolved'])
  })

  test('documents with no version are typed by the references into them, under either way with cycles', () => {
    const documents = {
      'Pet.yaml': { type: 'object', properties: { owner: { $ref: 'Owner.yaml' }, tags: { type: 'array', items: { $ref: 'defs.yaml#/Tag' } } } },
      'Owner.yaml': { type: 'object', properties: { pets: { type: 'array', items: { $ref: 'Pet.yaml' } } } },
      'defs.yaml': { Tag: { type: 'string' }, Unused: { $ref: 'nothing.yaml' } },
    }
    const doc = entry({ Pet: { $ref: 'Pet.yaml' } })
    const cut = resolve(doc, { retrievalUri: HERE, documents })
    assert.deepEqual(plain(cut.tree.components.schemas.Pet), {
      type: 'object',
      properties: {
        owner: { type: 'object', properties: { pets: { type: 'array', items: { $ref: 'Pet.yaml' } } } },
        tags: { type: 'array', items: { type: 'string' } },
      },
    })
    assert.deepEqual(cut.cuts.map((c) => [c.doc, c.at, c.targetDoc ?? '', c.target]), [[at('Owner.yaml'), '/properties/pets/items', at('Pet.yaml'), '']])
    // What no reference reaches is not read as anything: `Unused` is no
    // site, and is reported nowhere.
    assert.deepEqual(cut.unresolved, [])
    assert.equal(cut.provenance.length, 4)

    const kept = resolve(doc, { retrievalUri: HERE, documents, cycles: 'keep' })
    const pet = kept.tree.components.schemas.Pet
    assert.equal(pet.properties.owner.properties.pets.items, pet)
    assert.deepEqual(plain(pet.properties.tags), { type: 'array', items: { type: 'string' } })
    assert.deepEqual(kept.cuts, [])
  })

  test('the members beside a reference follow the version of the document the reference is in', () => {
    const old = {
      openapi: '3.0.3',
      info: { title: 'old', version: '1' },
      paths: {},
      components: { schemas: { A: { $ref: '#/components/schemas/B', description: 'beside, and not read in 3.0' }, B: { type: 'string' } } },
    }
    const r = resolve(entry({ New: { $ref: 'old.yaml#/components/schemas/B', description: 'beside, and applied in 3.1' }, Old: { $ref: 'old.yaml#/components/schemas/A' } }), {
      retrievalUri: HERE,
      documents: { 'old.yaml': old },
    })
    assert.deepEqual(plain(r.tree.components.schemas.New), { allOf: [{ type: 'string' }], description: 'beside, and applied in 3.1' })
    assert.deepEqual(plain(r.tree.components.schemas.Old), { type: 'string' })
  })

  test('the output shapes hold across documents', () => {
    const documents = { 'Pet.yaml': { type: 'object', properties: { name: { type: 'string' } } } }
    const doc = entry({ A: { $ref: 'Pet.yaml' }, B: { $ref: 'Pet.yaml' } })
    const shape = (options: object) => resolve(doc, { retrievalUri: HERE, documents, ...options })
    const site = shape({ sharing: 'site' }).tree.components.schemas
    assert.notEqual(site.A, site.B)
    assert.equal(site.A.properties, site.B.properties)
    const once = shape({ sharing: 'inline-once' })
    assert.deepEqual(plain(once.tree.components.schemas), { A: { type: 'object', properties: { name: { type: 'string' } } }, B: { $ref: 'Pet.yaml' } })
    assert.deepEqual(once.provenance.map((p) => p.status), ['resolved', 'kept'])
    const copy = shape({ sharing: 'copy', budget: 1000 }).tree.components.schemas
    assert.notEqual(copy.A.properties, copy.B.properties)
    const xref = shape({ xref: true }).tree.components.schemas
    assert.equal(xref.A['x-ref'], 'Pet.yaml')
  })

  test('the steps of every document count against one bound', () => {
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 400; i++) big['S' + i] = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }
    const doc = entry({ Pet: { $ref: 'defs.yaml#/S7' } })
    const options = { retrievalUri: HERE, documents: { 'defs.yaml': big } }
    assert.deepEqual(plain(resolve(doc, options).tree.components.schemas.Pet), big.S7)
    assert.throws(() => resolve(doc, { ...options, maxSteps: 300 }), (e: any) => e instanceof ResolveError && 'openapi_work' === e.code)
    let checks = 0
    assert.throws(
      () => resolve(doc, { ...options, checkEveryN: 100, onCheck: () => 3 > ++checks }),
      (e: any) => e instanceof ResolveError && 'openapi_cancel' === e.code,
    )
  })
})
