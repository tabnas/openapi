/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A description in several documents: `resolve` with `documents`.
//
// What the index says of a set of documents is in site-index.test.ts.
// This holds what `resolve` makes of it: the tree, what is shared, the
// cycles, and the reports. The specification's own examples of several
// documents are the fixtures of test/docs/.

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { parse, resolve, resolveAll, ResolveError } from '../dist/openapi'

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

  test('a document given as text may be anything at its root, and needs no version', () => {
    // A schema may be `true` or `false`, and a document may be a list
    // that a pointer reads into. Only a description has to be a map.
    const doc = entry({ Never: { $ref: 'never.json' }, Second: { $ref: 'list.yaml#/1' }, All: { $ref: 'list.yaml' }, None: { $ref: 'empty.yaml' } })
    const texts = { 'never.json': 'false', 'list.yaml': '- {type: string}\n- {type: number}\n', 'empty.yaml': '# nothing here\n' }
    const want = { Never: false, Second: { type: 'number' }, All: [{ type: 'string' }, { type: 'number' }], None: null }
    const r = resolve(doc, { retrievalUri: HERE, documents: texts })
    assert.deepEqual(plain(r.tree.components.schemas), want)
    assert.deepEqual(r.unresolved, [])
    // As bytes, and as the trees those texts are.
    const bytes = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, new TextEncoder().encode(text)]))
    assert.deepEqual(plain(resolve(doc, { retrievalUri: HERE, documents: bytes }).tree.components.schemas), want)
    const trees = { 'never.json': false, 'list.yaml': [{ type: 'string' }, { type: 'number' }], 'empty.yaml': null }
    assert.deepEqual(plain(resolve(doc, { retrievalUri: HERE, documents: trees }).tree.components.schemas), want)
    // Strict JSON asks a description for its version, and no other
    // document for one.
    const strict = resolve(entry({ Pet: { $ref: 'Pet.json' }, Never: { $ref: 'never.json' } }), {
      retrievalUri: HERE,
      parse: { strict: true },
      documents: { 'Pet.json': '{"type":"object"}', 'never.json': 'false' },
    })
    assert.deepEqual(plain(strict.tree.components.schemas), { Pet: { type: 'object' }, Never: false })
    // A stream of several documents is still not one document.
    assert.throws(
      () => resolve(doc, { retrievalUri: HERE, documents: { 'never.json': 'a: 1\n---\nb: 2\n' } }),
      (e: any) => 'openapi_stream' === e.code,
    )
    // An error in one of them says which, as the file it is in.
    const broken = (documents: Record<string, unknown>) => {
      try {
        resolve(doc, { retrievalUri: HERE, documents: { ...texts, ...documents } })
      } catch (e: any) {
        return e
      }
      return undefined
    }
    const syntax = broken({ 'list.yaml': '- {type: string}\n- }\n' })
    assert.equal(syntax.code, 'unexpected')
    assert.equal(syntax.fileName, at('list.yaml'))
    assert.ok(String(syntax.message).includes(at('list.yaml') + ':2:'), String(syntax.message))
    const copied = broken({ 'never.json': 'a: &a [' + 'x,'.repeat(400) + 'x]\nb: [' + '*a,'.repeat(4000) + '*a]\n' })
    assert.equal(copied.code, 'openapi_alias_budget')
    assert.equal(copied.fileName, at('never.json'))
    // The description's own text has no name to give.
    assert.throws(() => parse('- }\n'), (e: any) => undefined === e.fileName && String(e.message).includes('<no-file>'))
    // `parse` by itself reads a description, and holds it to its root.
    assert.throws(() => parse('false'), (e: any) => 'openapi_root' === e.code)
    assert.throws(() => parse('{"type":"object"}', { strict: true }), (e: any) => 'openapi_version' === e.code)
  })

  test('the texts of a description\'s documents are held together to what one text is', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `n${i}.yaml`)
    const refs = (n: number) => entry(Object.fromEntries(names(n).map((name, i) => ['S' + i, { $ref: name }])))
    const given = (n: number, text: unknown) => Object.fromEntries(names(n).map((name) => [name, text]))
    const sized = (code: string, where?: string) => (e: any) =>
      e instanceof ResolveError && code === e.code && (undefined === where || at(where) === e.at)

    // In size: three texts of 400 bytes are more than 1,000, though each
    // is under it. JSON text counts, which JSON.parse reads without a
    // limit when it is one text. A tree does not.
    const yaml = 'description: ' + 'x'.repeat(386) + '\n'
    const json = JSON.stringify({ description: 'x'.repeat(382) })
    assert.equal(yaml.length, 400)
    assert.equal(json.length, 400)
    for (const text of [yaml, json, new TextEncoder().encode(yaml)]) {
      assert.equal(resolve(refs(2), { retrievalUri: HERE, parse: { maxBytes: 1000 }, documents: given(2, text) }).unresolved.length, 0)
      assert.throws(() => resolve(refs(3), { retrievalUri: HERE, parse: { maxBytes: 1000 }, documents: given(3, text) }), sized('openapi_size', 'n2.yaml'))
    }
    assert.equal(resolve(refs(3), { retrievalUri: HERE, parse: { maxBytes: 1000 }, documents: given(3, parse(yaml)) }).unresolved.length, 0)

    // In work: a limit of a megabyte gives 100,000 steps. A text of
    // 12,000 small values takes a share of them, so one is read, and
    // several are stopped at one of the later ones.
    const small = 'enum: [' + 'x,'.repeat(12000) + 'x]\n'
    assert.equal(resolve(refs(1), { retrievalUri: HERE, parse: { maxBytes: 1_000_000 }, documents: given(1, small) }).unresolved.length, 0)
    assert.throws(
      () => resolve(refs(8), { retrievalUri: HERE, parse: { maxBytes: 1_000_000 }, documents: given(8, small) }),
      (e: any) => sized('openapi_work')(e) && at('n0.yaml') !== e.at && /steps to read together/.test(e.message),
    )

    // In what aliases copy out: each of these texts is read by itself,
    // under the budget one text has, and twenty of them are not.
    const copies = 'a: &a [' + 'x,'.repeat(40) + 'x]\n' + 'b: [' + '*a,'.repeat(1500) + '*a]\n'
    assert.equal(resolve(refs(4), { retrievalUri: HERE, documents: given(4, copies) }).unresolved.length, 0)
    assert.throws(() => resolve(refs(20), { retrievalUri: HERE, documents: given(20, copies) }), (e: any) => 'openapi_alias_budget' === e.code)
    // A limit that is no number of bytes is refused as `parse` refuses it.
    assert.throws(() => resolve(refs(1), { retrievalUri: HERE, parse: { maxBytes: -1 }, documents: given(1, yaml) }), TypeError)
    // A budget the caller gives is each text's own.
    assert.equal(
      resolve(refs(20), { retrievalUri: HERE, parse: { aliasBudget: 1_000_000 }, documents: given(20, copies) }).unresolved.length,
      0,
    )
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
    // A name with no document is a mistake, where null is a document
    // with nothing in it.
    assert.throws(() => resolve(doc, { retrievalUri: HERE, documents: { 'Pet.yaml': undefined } }), /gives no document for it/)
    assert.equal(resolve(doc, { retrievalUri: HERE, documents: { 'Pet.yaml': null } }).tree.components.schemas.Pet, null)
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

describe('several documents, connections', () => {
  const info = { title: 't', version: '1' }
  const other = {
    openapi: '3.1.0',
    info,
    paths: {
      '/far': {
        get: { operationId: 'farOp', tags: ['pets', 'unknown'], security: [{ Key: [] }, { Missing: [] }], responses: {} },
      },
    },
    components: {
      securitySchemes: { Key: { type: 'http', scheme: 'basic' } },
      links: { L: { operationId: 'nearOp' }, M: { operationId: 'farOp' }, N: { operationId: 'nowhere' } },
    },
  }
  const doc = {
    openapi: '3.1.0',
    info,
    tags: [{ name: 'pets' }],
    paths: { '/near': { get: { operationId: 'nearOp', responses: {} } }, '/far': { $ref: 'other.yaml#/paths/~1far' } },
    components: {
      securitySchemes: { Key: { type: 'apiKey', name: 'k', in: 'header' } },
      links: { ToFar: { operationId: 'farOp' } },
    },
  }
  const OTHER = at('other.yaml')

  test('a name used in another document is looked for in the description, and an operationId in every document', () => {
    const r = resolve(doc, { retrievalUri: HERE, documents: { 'other.yaml': other } })
    assert.deepEqual(
      r.connections.map((c) => [c.doc ?? '', c.kind, c.at, c.name, c.found, c.targetDoc ?? '', c.target]),
      [
        // The description names an operation that only the other document has.
        ['', 'operationId', '/components/links/ToFar/operationId', 'farOp', true, OTHER, '/paths/~1far/get'],
        // The other document's tag and security scheme are the description's.
        [OTHER, 'tag', '/paths/~1far/get/tags/0', 'pets', true, '', '/tags/0'],
        [OTHER, 'tag', '/paths/~1far/get/tags/1', 'unknown', false, '', null],
        [OTHER, 'securityScheme', '/paths/~1far/get/security/0/Key', 'Key', true, '', '/components/securitySchemes/Key'],
        [OTHER, 'securityScheme', '/paths/~1far/get/security/1/Missing', 'Missing', false, '', null],
        [OTHER, 'operationId', '/components/links/L/operationId', 'nearOp', true, '', '/paths/~1near/get'],
        [OTHER, 'operationId', '/components/links/M/operationId', 'farOp', true, OTHER, '/paths/~1far/get'],
        [OTHER, 'operationId', '/components/links/N/operationId', 'nowhere', false, '', null],
      ],
    )
    // With no other document the description's own names are judged as before.
    const alone = resolve(doc, { retrievalUri: HERE })
    assert.deepEqual(
      alone.connections.map((c) => [c.kind, c.at, c.found]),
      [['operationId', '/components/links/ToFar/operationId', false]],
    )
  })

  test('an operationId that two documents declare names both', () => {
    const twice = { ...other, paths: { '/far': { get: { operationId: 'nearOp', responses: {} } } }, components: {} }
    const r = resolve({ ...doc, components: { links: { Both: { operationId: 'nearOp' } } } }, { retrievalUri: HERE, documents: { 'other.yaml': twice } })
    const row = r.connections.find((c) => 'operationId' === c.kind)!
    assert.deepEqual([row.found, row.target, row.targetDoc, row.targets], [true, '/paths/~1near/get', undefined, ['/paths/~1near/get', OTHER + '#/paths/~1far/get']])
  })

  test('a document with no version is walked where a reference types it', () => {
    const r = resolve(
      { openapi: '3.1.0', info, paths: { '/pets': { $ref: 'pets.yaml' } }, components: { securitySchemes: { Key: { type: 'http', scheme: 'basic' } } } },
      {
        retrievalUri: HERE,
        documents: {
          'pets.yaml': { get: { security: [{ Key: [] }], externalDocs: { url: 'docs/pets.html' }, responses: {} }, 'x-notes': { security: [{ Ignored: [] }] } },
        },
      },
    )
    assert.deepEqual(
      r.connections.map((c) => [c.doc, c.kind, c.at, c.found, c.target]),
      [[at('pets.yaml'), 'securityScheme', '/get/security/0/Key', true, '/components/securitySchemes/Key']],
    )
    // A URL in it is read against the document it is written in.
    assert.deepEqual(
      r.urls.map((u) => [u.doc, u.at, u.uri]),
      [[at('pets.yaml'), '/get/externalDocs/url', at('docs/pets.html')]],
    )
  })
})

describe('several documents, loaded', () => {
  // A loader over a table, which says what it was asked for.
  const loader = (table: Record<string, unknown>) => {
    const asked: string[] = []
    return { asked, load: (uri: string) => (asked.push(uri), table[uri]) }
  }
  const chain = {
    [at('a.yaml')]: { A: { type: 'object', properties: { b: { $ref: 'b.yaml#/B' } } } },
    [at('b.yaml')]: 'B:\n  type: object\n  properties:\n    c: {$ref: "sub/c.yaml"}\n    again: {$ref: "a.yaml#/A"}\n',
    [at('sub/c.yaml')]: new TextEncoder().encode('{"type":"array","items":{"$ref":"../d.yaml#/D"}}'),
    [at('d.yaml')]: { D: { type: 'string' } },
    [at('unused.yaml')]: { never: 'asked for' },
  }

  test('the documents a description names are loaded in rounds, each once', async () => {
    const { asked, load } = loader(chain)
    const r = await resolveAll(entry({ A: { $ref: 'a.yaml#/A' }, Too: { $ref: 'a.yaml#/A' } }), { retrievalUri: HERE, load })
    assert.deepEqual(asked, [at('a.yaml'), at('b.yaml'), at('sub/c.yaml'), at('d.yaml')])
    assert.deepEqual(r.documents, asked)
    assert.deepEqual(plain(r.tree.components.schemas.A), {
      type: 'object',
      properties: {
        b: { type: 'object', properties: { c: { type: 'array', items: { type: 'string' } }, again: { $ref: 'a.yaml#/A' } } },
      },
    })
    assert.deepEqual(r.unresolved, [])
    assert.deepEqual(r.cuts.map((c) => [c.doc, c.at, c.targetDoc, c.target]), [[at('b.yaml'), '/B/properties/again', at('a.yaml'), '/A']])
    assert.equal(r.tree.components.schemas.A, r.tree.components.schemas.Too)
  })

  test('a document the loader does not have stays another document, and is asked for once', async () => {
    const { asked, load } = loader({ [at('a.yaml')]: { A: { $ref: 'gone.yaml#/X' }, B: { $ref: 'gone.yaml#/Y' } } })
    const doc = entry({ A: { $ref: 'a.yaml#/A' }, B: { $ref: 'a.yaml#/B' }, C: { $ref: 'https://elsewhere.example/c.yaml' } })
    const r = await resolveAll(doc, { retrievalUri: HERE, load })
    assert.deepEqual(asked, [at('a.yaml'), 'https://elsewhere.example/c.yaml', at('gone.yaml')])
    assert.deepEqual(r.documents, [at('a.yaml')])
    // A reference to a reference left as written is left as written, for
    // the same reason, in whichever document each is.
    assert.deepEqual(
      r.unresolved.map((u) => [u.doc ?? '', u.at, u.why]),
      [
        ['', '/components/schemas/A', 'external'],
        [at('a.yaml'), '/A', 'external'],
        ['', '/components/schemas/B', 'external'],
        [at('a.yaml'), '/B', 'external'],
        ['', '/components/schemas/C', 'external'],
      ],
    )
    // Under `strict` the rounds still run, and what is left is refused.
    await assert.rejects(
      () => resolveAll(doc, { retrievalUri: HERE, load, strict: true }),
      (e: any) => e instanceof ResolveError && 'openapi_unresolved' === e.code,
    )
  })

  test('a document given is not asked for, and a loader may be asynchronous', async () => {
    const asked: string[] = []
    const load = async (uri: string) => {
      asked.push(uri)
      await new Promise((done) => setTimeout(done, 1))
      return chain[uri]
    }
    const r = await resolveAll(entry({ A: { $ref: 'a.yaml#/A' } }), {
      retrievalUri: HERE,
      load,
      documents: { 'a.yaml': chain[at('a.yaml')], 'b.yaml': chain[at('b.yaml')] },
    })
    assert.deepEqual(asked, [at('sub/c.yaml'), at('d.yaml')])
    assert.deepEqual(r.documents, [at('a.yaml'), at('b.yaml'), at('sub/c.yaml'), at('d.yaml')])
    assert.deepEqual(r.unresolved, [])
  })

  test('a document named by a connection alone is loaded too', async () => {
    const { asked, load } = loader({
      [at('ops.yaml')]: { openapi: '3.1.0', info: { title: 'ops', version: '1' }, paths: { '/pets': { get: { operationId: 'list', responses: {} } } } },
    })
    const doc = {
      openapi: '3.1.0',
      info: { title: 'entry', version: '1' },
      paths: {},
      components: { links: { Next: { operationRef: 'ops.yaml#/paths/~1pets/get' } } },
    }
    const r = await resolveAll(doc, { retrievalUri: HERE, load })
    assert.deepEqual(asked, [at('ops.yaml')])
    const row = r.connections.find((c) => 'operationRef' === c.kind)!
    assert.deepEqual([row.found, row.target, row.targetDoc, row.type], [true, '/paths/~1pets/get', at('ops.yaml'), 'operation'])
  })

  test('the documents asked for are held to a count, whether or not the loader has them', async () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 12; i++) many[at(`n${i}.yaml`)] = { N: { $ref: `n${i + 1}.yaml#/N` } }
    const doc = entry({ N: { $ref: 'n0.yaml#/N' } })
    const all = await resolveAll(doc, { retrievalUri: HERE, load: loader(many).load })
    assert.equal(all.documents.length, 12)
    const tooMany = (where: string) => (e: any) => e instanceof ResolveError && 'openapi_work' === e.code && at(where) === e.at
    await assert.rejects(() => resolveAll(doc, { retrievalUri: HERE, load: loader(many).load, maxDocuments: 5 }), tooMany('n5.yaml'))
    await assert.rejects(() => resolveAll(doc, { retrievalUri: HERE } as any), TypeError)
    await assert.rejects(() => resolveAll(doc, { retrievalUri: HERE, load: loader(many).load, maxDocuments: 0 }), TypeError)

    // A document the loader does not have costs an asking all the same,
    // which over HTTP is a request.
    const absent = entry(Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['S' + i, { $ref: `gone${i}.yaml` }])))
    const nothing = loader({})
    const left = await resolveAll(absent, { retrievalUri: HERE, load: nothing.load })
    assert.equal(nothing.asked.length, 8)
    assert.equal(left.unresolved.length, 8)
    const counted = loader({})
    await assert.rejects(() => resolveAll(absent, { retrievalUri: HERE, load: counted.load, maxDocuments: 5 }), tooMany('gone5.yaml'))
    assert.equal(counted.asked.length, 5)
  })

  test('a loader may answer null for a document it does not have', async () => {
    const doc = entry({ Pet: { $ref: 'Pet.yaml' }, Gone: { $ref: 'gone.yaml' } })
    const r = await resolveAll(doc, { retrievalUri: HERE, load: (uri: string) => (uri.endsWith('Pet.yaml') ? { type: 'object' } : null) })
    assert.deepEqual(plain(r.tree.components.schemas), { Pet: { type: 'object' }, Gone: { $ref: 'gone.yaml' } })
    assert.deepEqual(r.documents, [at('Pet.yaml')])
    assert.deepEqual(r.unresolved.map((u) => [u.at, u.why]), [['/components/schemas/Gone', 'external']])
  })

  test('the rounds of loading are held to a count', async () => {
    // Each document names the next, so each takes a round to find, and a
    // round indexes every document before it again.
    const linked = (n: number) => {
      const table: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) table[at(`n${i}.yaml`)] = i + 1 < n ? { N: { $ref: `n${i + 1}.yaml#/N` } } : { N: { type: 'string' } }
      return table
    }
    const doc = entry({ N: { $ref: 'n0.yaml#/N' } })
    const deep = (e: any) => e instanceof ResolveError && 'openapi_work' === e.code && /rounds of loading/.test(e.message)
    assert.equal((await resolveAll(doc, { retrievalUri: HERE, load: loader(linked(64)).load })).documents.length, 64)
    const stopped = loader(linked(65))
    await assert.rejects(() => resolveAll(doc, { retrievalUri: HERE, load: stopped.load }), (e: any) => deep(e) && at('n64.yaml') === e.at)
    assert.equal(stopped.asked.length, 64)
    assert.equal((await resolveAll(doc, { retrievalUri: HERE, load: loader(linked(65)).load, maxRounds: 65 })).documents.length, 65)
    await assert.rejects(() => resolveAll(doc, { retrievalUri: HERE, load: loader(linked(4)).load, maxRounds: 3 }), deep)
    await assert.rejects(() => resolveAll(doc, { retrievalUri: HERE, load: loader(linked(4)).load, maxRounds: 0 }), TypeError)
    // Given with the description, the same documents take no rounds.
    const given = resolve(doc, { retrievalUri: HERE, documents: linked(65) })
    assert.deepEqual(plain(given.tree.components.schemas.N), { type: 'string' })
  })

  test('the texts a loader gives are held together to what one text is', async () => {
    const doc = entry(Object.fromEntries(Array.from({ length: 3 }, (_, i) => ['S' + i, { $ref: `n${i}.yaml` }])))
    const text = 'description: ' + 'x'.repeat(386) + '\n'
    const load = () => text
    await assert.rejects(
      () => resolveAll(doc, { retrievalUri: HERE, load, parse: { maxBytes: 1000 } }),
      (e: any) => e instanceof ResolveError && 'openapi_size' === e.code && at('n2.yaml') === e.at,
    )
    assert.equal((await resolveAll(doc, { retrievalUri: HERE, load, parse: { maxBytes: 1200 } })).documents.length, 3)
    // A text given with the description counts with the ones loaded.
    await assert.rejects(
      () => resolveAll(doc, { retrievalUri: HERE, load, parse: { maxBytes: 1200 }, documents: { 'given.yaml': text } }),
      (e: any) => e instanceof ResolveError && 'openapi_size' === e.code,
    )
    // A text that does not parse says which document it is.
    await assert.rejects(
      () => resolveAll(doc, { retrievalUri: HERE, load: (uri: string) => (uri.endsWith('n1.yaml') ? 'a: }\n' : 'type: string\n') }),
      (e: any) => 'unexpected' === e.code && at('n1.yaml') === e.fileName,
    )
    // A loader's text may be a schema that is not a map.
    const never = await resolveAll(entry({ Never: { $ref: 'never.json' } }), { retrievalUri: HERE, load: () => 'false' })
    assert.equal(never.tree.components.schemas.Never, false)
  })
})
