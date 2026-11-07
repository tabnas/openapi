/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The plugin installs on jsonic with the yaml grammar, or with `strict`
// on the json grammar alone, and changes nothing yet: the Petstore
// description parses to the tree jsonic and yaml give without it, from
// its YAML form and its JSON form alike, and the JSON form to what
// JSON.parse gives. The JSON copy in test/petstore was written from the
// YAML by an independent reader, so the two agreeing is a check of the
// parse rather than of a copy made by it.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { Yaml } from '@tabnas/yaml'

import { OpenApi, make, parse, version, VERSION } from '..'

const PETSTORE = join(__dirname, '..', '..', 'test', 'petstore')
const read = (name: string) => readFileSync(join(PETSTORE, name), 'utf8')

// The engine builds null-prototype containers; a JSON round trip compares
// the value and not the prototype.
const C = (x: any) => JSON.parse(JSON.stringify(x))

describe('openapi', () => {
  test('exports the plugin, make and VERSION', () => {
    assert.equal('function', typeof OpenApi)
    assert.equal('function', typeof make)
    assert.match(VERSION, /^\d+\.\d+\.\d+/)
  })

  test('the YAML description parses as jsonic and yaml alone parse it', () => {
    const yaml = read('petstore.yaml')
    const base = new Tabnas().use(jsonic).use(Yaml)
    assert.deepEqual(C(make().parse(yaml)), C(base.parse(yaml)))
  })

  test('the YAML and JSON forms parse to one document', () => {
    const want = JSON.parse(read('petstore.json'))
    assert.deepEqual(C(make().parse(read('petstore.yaml'))), want)
    assert.deepEqual(C(make().parse(read('petstore.json'))), want)
  })

  test('strict reads the JSON form and refuses the YAML form', () => {
    const strict = make({ strict: true })
    assert.deepEqual(C(strict.parse(read('petstore.json'))), JSON.parse(read('petstore.json')))
    assert.throws(() => strict.parse(read('petstore.yaml')))
  })

  test('the plugin installs by hand on jsonic with the yaml grammar', () => {
    const tn = new Tabnas().use(jsonic).use(Yaml).use(OpenApi)
    assert.deepEqual(C(tn.parse('paths:\n  /pets: {}')), { paths: { '/pets': {} } })
  })
})

// Every map in a tree, with its path, for the prototype and order checks.
function maps(node: any, path = '', out: [string, any][] = []): [string, any][] {
  if (Array.isArray(node)) {
    node.forEach((item, i) => maps(item, path + '/' + i, out))
  } else if (null != node && 'object' === typeof node) {
    out.push([path, node])
    for (const name of Object.keys(node)) maps(node[name], path + '/' + name, out)
  }
  return out
}

// The error a call throws, as the engine serialises it.
function failure(fn: () => unknown): any {
  try {
    fn()
  } catch (err: any) {
    return { ...err.toJSON(), err }
  }
  assert.fail('expected an error')
}

describe('raw mode', () => {
  test('parse reads the petstore in both forms to one document', () => {
    const want = JSON.parse(read('petstore.json'))
    for (const name of ['petstore.yaml', 'petstore.json']) {
      for (const fast of [true, false, 'auto'] as const) {
        assert.deepEqual(C(parse(read(name), { fast })), want, name + ' fast ' + fast)
      }
    }
    assert.deepEqual(C(parse(read('petstore.json'), { strict: true })), want)
  })

  test('both paths build maps without a prototype, members in one order', () => {
    const fast = maps(parse(read('petstore.json'), { fast: true }))
    const grammar = maps(parse(read('petstore.json'), { fast: false }))
    assert.equal(fast.length, grammar.length)
    for (let i = 0; i < fast.length; i++) {
      assert.equal(fast[i][0], grammar[i][0])
      assert.equal(Object.getPrototypeOf(fast[i][1]), null, 'fast ' + fast[i][0])
      assert.equal(Object.getPrototypeOf(grammar[i][1]), null, 'grammar ' + grammar[i][0])
      assert.deepEqual(Object.keys(fast[i][1]), Object.keys(grammar[i][1]))
    }
  })

  test('a member named __proto__ is data on both paths', () => {
    for (const fast of [true, false]) {
      const tree = parse('{"__proto__":{"polluted":1},"a":[{"__proto__":2}]}', { fast })
      assert.deepEqual(Object.keys(tree), ['__proto__', 'a'])
      assert.equal(Object.getPrototypeOf(tree), null)
      assert.equal(Object.getPrototypeOf(tree.a[0]), null)
      assert.equal(({} as any).polluted, undefined)
    }
  })

  test('numbers JSON cannot carry, and lone surrogates, agree across paths', () => {
    for (const fast of [true, false]) {
      assert.equal(parse('{"a":1e400}', { fast }).a, Infinity)
      assert.equal(parse('{"a":-1e400}', { fast }).a, -Infinity)
      assert.equal(parse('{"a":"\\ud800"}', { fast }).a, '\ud800')
      assert.ok(Object.is(parse('{"a":-0}', { fast }).a, -0))
    }
    assert.equal(parse('a: .inf').a, Infinity)
    assert.equal(parse('a: -.inf').a, -Infinity)
    assert.ok(Number.isNaN(parse('a: .nan').a))
  })

  test('the errors carry the position of what they refuse', () => {
    const stream = failure(() => parse('openapi: 3.1.0\n---\nopenapi: 3.0.0'))
    // At the first line of the second document's content.
    assert.deepEqual([stream.code, stream.row, stream.col], ['openapi_stream', 3, 1])

    const root = failure(() => parse('- a\n- b'))
    assert.deepEqual([root.code, root.row, root.col], ['openapi_root', 1, 1])
    assert.match(root.message, /is a list at its root/)

    const empty = failure(() => parse(''))
    assert.deepEqual([empty.code, empty.row, empty.col], ['openapi_root', 1, 1])
    assert.match(empty.message, /is empty at its root/)

    const dup = failure(() => parse('{"openapi":"3.1.0",\n  "a":1,\n  "a":2}', { strict: true }))
    assert.deepEqual([dup.code, dup.row, dup.col], ['openapi_duplicate_key', 3, 3])

    const ver = failure(() => parse('{"openapi":"4.0.0"}', { strict: true }))
    assert.equal(ver.code, 'openapi_version')
    assert.match(ver.message, /openapi is "4\.0\.0"/)
    assert.ok(0 < ver.hint.length)
  })

  test('a member name in a message is quoted and cut short', () => {
    const odd = failure(() => parse('{"openapi":"3.1.0","a\\"\\nb":1,"a\\"\\nb":2}', { strict: true }))
    assert.match(odd.message, /"a\\"\\nb"/)
    const long = 'k'.repeat(200)
    const cut = failure(() =>
      parse('{"openapi":"3.1.0","' + long + '":1,"' + long + '":2}', { strict: true }),
    )
    assert.ok(!cut.message.includes(long))
    assert.match(cut.message, /k\.\.\./)
  })

  test('the engine parse raises nothing of the plugin', () => {
    const tn = make()
    assert.deepEqual(C(tn.parse('a: 1\n---\nb: 2')), [{ a: 1 }, { b: 2 }])
    assert.deepEqual(C(tn.parse('- a')), ['a'])
    assert.equal(tn.parse(''), undefined)
    assert.deepEqual(C(make({ strict: true }).parse('{"a":1,"a":2}')), { a: 2 })
  })

  test('parse refuses what it cannot read', () => {
    assert.throws(() => parse(42 as any), TypeError)
    assert.throws(
      () => parse('{}', { instance: new Tabnas().use(jsonic).use(Yaml) }),
      /no OpenApi plugin/,
    )
  })

  test('a given instance is used', () => {
    const tn = make()
    assert.deepEqual(C(parse('a: 1', { instance: tn, fast: false })), { a: 1 })
  })

  test('version reads openapi and swagger leniently', () => {
    const cases: [string, string, string | null][] = [
      ['openapi: 3.1.0', '3.1', 'openapi'],
      ['openapi: "3.0.3"', '3.0', 'openapi'],
      ['openapi: 3.2.0', '3.2', 'openapi'],
      ['openapi: 3.1', '3.1', 'openapi'],
      ['openapi: 3.0', '3.0', 'openapi'],
      ['openapi: 3.1.1-rc0', '3.1', 'openapi'],
      ['swagger: "2.0"', '2.0', 'swagger'],
      ['swagger: 2.0', '2.0', 'swagger'],
      ['openapi: 4.0.0', 'unknown', 'openapi'],
      ['swagger: "1.2"', 'unknown', 'swagger'],
      ['info: {}', 'unknown', null],
      ['openapi: 3.1.0\nswagger: "2.0"', '3.1', 'openapi'],
    ]
    for (const [src, want, field] of cases) {
      const got = version(parse(src))
      assert.equal(got.version, want, src)
      assert.equal(got.field, field, src)
    }
    assert.deepEqual(version(['a']), { version: 'unknown', field: null, value: undefined })
    assert.equal(version(parse('openapi: 3.1')).value, 3.1)
  })
})
