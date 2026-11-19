/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The normal form of a URI, which every comparison of two URIs goes
// through, and the dialect an identifier names. What `resolve` makes of
// each is in test/resolve/uris.tsv and test/resolve/dialects.tsv.

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { DIALECTS, dialectOf } from '../dist/dialect'
import { schemaStates, slot, step } from '../dist/model'
import { normalizeEncoding, normalizeUri } from '../dist/uri'

describe('normalizeUri', () => {
  test("gives RFC 3986's two example URIs one form", () => {
    // Section 6.2.2: these two are equivalent.
    const one = normalizeUri('example://a/b/c/%7Bfoo%7D')
    assert.equal(one, 'example://a/b/c/%7Bfoo%7D')
    assert.equal(normalizeUri('eXAMPLE://a/./b/../b/%63/%7bfoo%7d'), one)
  })

  test('writes the scheme and the host in lower case, and nothing else', () => {
    assert.equal(normalizeUri('HTTP://www.Example.COM/Path/File.JSON?Q=A#Frag'), 'http://www.example.com/Path/File.JSON?Q=A#Frag')
    assert.equal(normalizeUri('http://User:Pass@Example.com/'), 'http://User:Pass@example.com/')
    assert.equal(normalizeUri('URN:Example:A'), 'urn:Example:A')
    assert.equal(normalizeUri('http://[2001:DB8::1]/a'), 'http://[2001:db8::1]/a')
  })

  test("drops an empty port and the scheme's own", () => {
    assert.equal(normalizeUri('http://example.com:80/a'), 'http://example.com/a')
    assert.equal(normalizeUri('https://example.com:443/a'), 'https://example.com/a')
    assert.equal(normalizeUri('http://example.com:/a'), 'http://example.com/a')
    assert.equal(normalizeUri('http://[::1]:80/a'), 'http://[::1]/a')
    // Another scheme's default is a port like any other.
    assert.equal(normalizeUri('http://example.com:443/a'), 'http://example.com:443/a')
    assert.equal(normalizeUri('https://example.com:8443/a'), 'https://example.com:8443/a')
    assert.equal(normalizeUri('example://host:80/a'), 'example://host:80/a')
  })

  test('writes `/` for an empty path beside an authority', () => {
    assert.equal(normalizeUri('http://example.com'), 'http://example.com/')
    assert.equal(normalizeUri('http://example.com?q'), 'http://example.com/?q')
    assert.equal(normalizeUri('http://example.com#f'), 'http://example.com/#f')
    assert.equal(normalizeUri('urn:x'), 'urn:x')
  })

  test('removes dot segments from a path that starts at the root', () => {
    assert.equal(normalizeUri('http://a/b/c/./../../g'), 'http://a/g')
    assert.equal(normalizeUri('http://a/../g'), 'http://a/g')
    assert.equal(normalizeUri('file:///C:/a/./b/../c'), 'file:///C:/a/c')
    assert.equal(normalizeUri('file:/a/./b'), 'file:/a/b')
    // A path that does not start at the root is not one to walk.
    assert.equal(normalizeUri('urn:a/../b'), 'urn:a/../b')
    assert.equal(normalizeUri('a/../b'), 'a/../b')
  })

  test('decodes a percent-encoded unreserved character, and writes the hex of any other in upper case', () => {
    assert.equal(normalizeEncoding('%41%5a%61%7A%30%39%2d%2E%5f%7e'), 'AZaz09-._~')
    assert.equal(normalizeEncoding('%2f%3a%20%7b%e2%82%ac'), '%2F%3A%20%7B%E2%82%AC')
    assert.equal(normalizeEncoding('100%'), '100%')
    assert.equal(normalizeEncoding('%zz'), '%zz')
    assert.equal(normalizeUri('http://e.com/%61/%2fb?%63=%2f#%64%2f'), 'http://e.com/a/%2Fb?c=%2F#d%2F')
    assert.equal(normalizeUri('http://ex%61mple.com/'), 'http://example.com/')
    assert.equal(normalizeUri('http://EX%41MPLE.com/'), 'http://example.com/')
  })

  test('leaves a URI in its normal form as it is', () => {
    for (const u of [
      'https://e.com/a/api.yaml',
      'https://e.com/',
      'urn:uuid:0c2b4f0e-8f9d-4c7a-9a52-6d1e3b7a4f10',
      'http://[2001:db8::1]:8080/a%2Fb?q=%20#/x~1y',
      'file:///a/b',
      '',
      '#frag',
    ]) {
      assert.equal(normalizeUri(u), u)
      assert.equal(normalizeUri(normalizeUri(u)), u)
    }
  })
})

describe('dialectOf', () => {
  const name = (uri: string) => {
    const d = dialectOf(uri)
    return d.dialect.name + (d.known ? '' : ' unknown')
  }

  test('knows the five dialects, in any spelling of their identifiers', () => {
    assert.equal(name('http://json-schema.org/draft-04/schema#'), 'draft-04')
    assert.equal(name('http://json-schema.org/draft-06/schema#'), 'draft-06')
    assert.equal(name('http://json-schema.org/draft-07/schema#'), 'draft-07')
    assert.equal(name('https://json-schema.org/draft/2019-09/schema'), '2019-09')
    assert.equal(name('https://json-schema.org/draft/2020-12/schema'), '2020-12')
    // The empty fragment or none, `http` or `https`, any case of the host.
    assert.equal(name('http://json-schema.org/draft-07/schema'), 'draft-07')
    assert.equal(name('https://json-schema.org/draft-07/schema#'), 'draft-07')
    assert.equal(name('https://json-schema.org/draft/2020-12/schema#'), '2020-12')
    assert.equal(name('http://json-schema.org/draft/2019-09/schema#'), '2019-09')
    assert.equal(name('HTTP://JSON-SCHEMA.ORG:80/draft-04/schema#'), 'draft-04')
  })

  test("reads a draft's hyper-schema dialect as the draft", () => {
    assert.equal(name('http://json-schema.org/draft-04/hyper-schema#'), 'draft-04')
    assert.equal(name('http://json-schema.org/draft-07/hyper-schema#'), 'draft-07')
    assert.equal(name('https://json-schema.org/draft/2019-09/hyper-schema'), '2019-09')
    assert.equal(name('https://json-schema.org/draft/2020-12/hyper-schema'), '2020-12')
  })

  test('reads the OpenAPI dialects of 3.1 and 3.2 as 2020-12', () => {
    assert.equal(name('https://spec.openapis.org/oas/3.1/dialect/base'), '2020-12')
    assert.equal(name('https://spec.openapis.org/oas/3.1/dialect/2024-11-10'), '2020-12')
    assert.equal(name('https://spec.openapis.org/oas/3.2/dialect/2026-02-26'), '2020-12')
  })

  test('reads any other as 2020-12, and says it does not know it', () => {
    for (const uri of [
      'https://example.com/my-dialect',
      'http://json-schema.org/draft-03/schema#',
      'http://json-schema.org/draft-05/schema#',
      'http://json-schema.org/schema#',
      'https://json-schema.org/draft/2021-01/schema',
      'https://json-schema.org/draft/2020-12/schema#fragment',
      'https://json-schema.org/draft/2020-12/schema/more',
      'https://json-schema.org/draft/2020-12/meta/core',
      'https://spec.openapis.org/oas/3.0/dialect/base',
      'https://spec.openapis.org/oas/3.3/dialect/base',
      'https://spec.openapis.org/oas/3.1/dialect/',
      'https://spec.openapis.org/oas/3.1/schema/2026-11-05',
      'draft-07',
      '',
    ]) {
      assert.equal(name(uri), '2020-12 unknown', uri)
    }
  })

  test('each dialect has its own rules', () => {
    const rules = (n: keyof typeof DIALECTS) => {
      const d = DIALECTS[n]
      return [d.id, d.idAnchor, d.anchors.join(','), d.refAlone, d.dynamic]
    }
    assert.deepEqual(rules('draft-04'), ['id', true, '', true, null])
    assert.deepEqual(rules('draft-06'), ['$id', true, '', true, null])
    assert.deepEqual(rules('draft-07'), ['$id', true, '', true, null])
    assert.deepEqual(rules('2019-09'), ['$id', false, '$anchor', false, '$recursiveRef'])
    assert.deepEqual(rules('2020-12'), ['$id', false, '$anchor,$dynamicAnchor', false, '$dynamicRef'])
  })
})

describe('the Schema Object of each dialect', () => {
  // What a member of a Schema Object read by a dialect holds: `schema`
  // for a schema, `map` for a map of them, `list` for a list of them, and
  // `-` for anything else.
  const holds = (version: '3.1' | '3.2', dialect: string, member: string): string => {
    const state = schemaStates(version)[dialect]
    const next = step(version, state, member)
    if ('data' === next) return '-'
    if (next === state) return 'schema'
    const s = slot(version, next)
    if ('object' === s.kind && step(version, next, 'any') === state) return 'map'
    if ('list' === s.kind && step(version, next, 0) === state) return 'list'
    return next
  }

  // Every member that holds schemas in some dialect, by dialect.
  const MEMBERS: Record<string, string[]> = {
    //                      04        06        07        2019-09   2020-12
    properties:           ['map',    'map',    'map',    'map',    'map'],
    patternProperties:    ['map',    'map',    'map',    'map',    'map'],
    additionalProperties: ['schema', 'schema', 'schema', 'schema', 'schema'],
    items:                ['schema', 'schema', 'schema', 'schema', 'schema'],
    additionalItems:      ['schema', 'schema', 'schema', 'schema', '-'],
    prefixItems:          ['-',      '-',      '-',      '-',      'list'],
    allOf:                ['list',   'list',   'list',   'list',   'list'],
    anyOf:                ['list',   'list',   'list',   'list',   'list'],
    oneOf:                ['list',   'list',   'list',   'list',   'list'],
    not:                  ['schema', 'schema', 'schema', 'schema', 'schema'],
    definitions:          ['map',    'map',    'map',    '-',      '-'],
    dependencies:         ['map',    'map',    'map',    '-',      '-'],
    $defs:                ['-',      '-',      '-',      'map',    'map'],
    dependentSchemas:     ['-',      '-',      '-',      'map',    'map'],
    contains:             ['-',      'schema', 'schema', 'schema', 'schema'],
    propertyNames:        ['-',      'schema', 'schema', 'schema', 'schema'],
    if:                   ['-',      '-',      'schema', 'schema', 'schema'],
    then:                 ['-',      '-',      'schema', 'schema', 'schema'],
    else:                 ['-',      '-',      'schema', 'schema', 'schema'],
    unevaluatedItems:     ['-',      '-',      '-',      'schema', 'schema'],
    unevaluatedProperties: ['-',     '-',      '-',      'schema', 'schema'],
    contentSchema:        ['-',      '-',      '-',      'schema', 'schema'],
  }
  const NAMES = ['draft-04', 'draft-06', 'draft-07', '2019-09', '2020-12']

  for (const version of ['3.1', '3.2'] as const) {
    test(`${version}: the members that hold schemas are the dialect's own`, () => {
      assert.deepEqual(Object.keys(schemaStates(version)).sort(), [...NAMES].sort())
      for (const [member, row] of Object.entries(MEMBERS)) {
        NAMES.forEach((dialect, i) => {
          assert.equal(holds(version, dialect, member), row[i], `${dialect} ${member}`)
        })
      }
      // Where `items` may be a list of schemas, the place of a schema may
      // hold a list of them: every dialect before 2020-12, which has
      // `prefixItems` for that.
      for (const dialect of NAMES) {
        const state = schemaStates(version)[dialect]
        assert.equal(step(version, state, 0), '2020-12' === dialect ? 'data' : state, dialect)
      }
    })

    test(`${version}: what OpenAPI adds to a schema, and its plain values, are the same in every dialect`, () => {
      const own = schemaStates(version)['2020-12']
      for (const dialect of NAMES) {
        const state = schemaStates(version)[dialect]
        assert.equal(slot(version, state).kind, 'schema')
        assert.equal(slot(version, state).type, 'schema')
        assert.equal(slot(version, state).dialect, dialect)
        for (const member of ['discriminator', 'xml', 'externalDocs', 'example', 'examples', 'const', 'enum', 'default', '$ref', 'x-any']) {
          assert.equal(step(version, state, member), step(version, own, member), `${dialect} ${member}`)
        }
      }
    })
  }

  test('2.0 and 3.0 have the one dialect each', () => {
    assert.deepEqual(schemaStates('2.0'), { 'draft-04': 'schema' })
    assert.deepEqual(schemaStates('3.0'), { 'wright-00': 'schema' })
  })
})
