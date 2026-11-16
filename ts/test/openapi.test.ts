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

import { spawnSync } from 'node:child_process'

import { OpenApi, aliasedSize, make, parse, version, wellFormed, VERSION } from '..'
import type { ParseReport } from '..'

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

  test('installing the plugin twice changes nothing', () => {
    const tn = make().use(OpenApi)
    assert.deepEqual(C(parse('openapi: 3.1.0\npaths: {}', { instance: tn })), {
      openapi: '3.1.0',
      paths: {},
    })
    assert.equal(failure(() => parse('a: 1\n---\nb: 2', { instance: tn })).code, 'openapi_stream')
  })

  test('a given instance is used', () => {
    const tn = make()
    assert.deepEqual(C(parse('a: 1', { instance: tn, fast: false })), { a: 1 })
  })

  // What test/pending/parse-duplicates.tsv cannot say: a fixture compares
  // after a JSON round trip, which hides a prototype.
  test('a merged tree has no prototype anywhere, and pollutes none', () => {
    const merge = { duplicates: 'merge' as const }
    const bare = (v: any): boolean =>
      null == v || 'object' !== typeof v
        ? true
        : Array.isArray(v)
          ? v.every(bare)
          : null === Object.getPrototypeOf(v) && Object.values(v).every(bare)
    for (const text of [
      'a:\n  x: {p: 1}\na:\n  y: {q: 2}\n',
      '{"a":{"x":{"p":1}},"a":{"y":{"q":[{"r":2}]}}}',
      'a: 1\na:\n  y: {q: 2}\n',
      'a: [{x: 1}]\na: [{y: 2}, {z: 3}]\n',
    ]) {
      assert.ok(bare(parse(text, merge)), 'a map with a prototype in ' + JSON.stringify(text))
    }
    const tree = parse('{"a":{"x":1},"a":{"__proto__":{"polluted":true},"constructor":{"polluted":true}}}', merge)
    assert.deepEqual(C(tree), { a: { x: 1 } })
    assert.equal(({} as any).polluted, undefined)
  })

  test('duplicates takes last or merge, and a parse of the engine alone keeps the last', () => {
    assert.throws(() => parse('a: 1', { duplicates: 'first' as any }), /duplicates must be last or merge, not "first"/)
    assert.deepEqual(C(parse('a: {x: 1}\na: {y: 2}', { duplicates: undefined })), { a: { y: 2 } })
    // The option is `parse`'s: the engine's own parse of the same instance
    // is not given it, and keeps the last value.
    assert.deepEqual(C(make().parse('a: {x: 1}\na: {y: 2}')), { a: { y: 2 } })
  })

  test('a given instance merges when the parse asks, and one parse does not reach the next', () => {
    const tn = make()
    const text = 'a: {x: 1}\na: {y: 2}'
    assert.deepEqual(C(parse(text, { instance: tn, duplicates: 'merge' })), { a: { x: 1, y: 2 } })
    assert.deepEqual(C(parse(text, { instance: tn })), { a: { y: 2 } })
    assert.deepEqual(C(parse(text, { duplicates: 'merge' })), { a: { x: 1, y: 2 } })
    assert.deepEqual(C(parse(text)), { a: { y: 2 } })
  })

  test('reading takes base or spec, and a parser reads one way', () => {
    assert.throws(() => make({ reading: 'core' as any }), TypeError)
    assert.throws(() => parse('a: 1', { reading: 'core' as any }), TypeError)

    // The shared parsers are one for each reading, and one parse does
    // not reach the next.
    assert.deepEqual(C(parse('a: 0b11\nb: //x\n', { reading: 'spec' })), { a: '0b11', b: '//x' })
    assert.deepEqual(C(parse('a: 0b11\nb: //x\n')), { a: 3, b: null })
    assert.deepEqual(C(parse('a: 0b11\n', { reading: 'base' })), { a: 3 })

    // A given parser reads as `make` built it, and a parse that asks for
    // the other reading is refused.
    const spec = make({ reading: 'spec' })
    assert.deepEqual(C(parse('a: 0b11\n', { instance: spec })), { a: '0b11' })
    assert.deepEqual(C(parse('a: 0b11\n', { instance: spec, reading: 'spec' })), { a: '0b11' })
    assert.throws(() => parse('a: 1', { instance: spec, reading: 'base' }), /the instance reads as spec/)
    assert.throws(() => parse('a: 1', { instance: make(), reading: 'spec' }), /the instance reads as base/)
    // A stream is judged by the reading too, with a given parser as without.
    assert.deepEqual(C(parse('a: 1\n---\n', { instance: spec })), { a: 1 })
    assert.throws(() => parse('a: 1\n---\n', { instance: make() }), (e: any) => 'openapi_stream' === e.code)

    // Strict JSON has one reading.
    const text = '{"openapi":"3.1.0","a":1e3}'
    assert.deepEqual(C(parse(text, { strict: true, reading: 'spec' })), { openapi: '3.1.0', a: 1000 })
    assert.deepEqual(C(parse(text, { instance: make({ strict: true, reading: 'spec' }), strict: true })), { openapi: '3.1.0', a: 1000 })
    assert.throws(() => parse('{"openapi":"3.1.0","a":0x1F}', { strict: true, reading: 'spec' }), (e: any) => 'unexpected' === e.code)
  })

  test('the specification\'s reading keeps the numbers JSON cannot carry', () => {
    const t = parse('a: .inf\nb: -.INF\nc: .NaN\nd: Infinity\ne: +.Inf\n', { reading: 'spec' })
    assert.equal(t.a, Infinity)
    assert.equal(t.b, -Infinity)
    assert.ok(Number.isNaN(t.c))
    assert.equal(t.d, 'Infinity')
    assert.equal(t.e, Infinity)
  })

  test('a text of white space and comments alone is an empty document', () => {
    const kind = (text: string, options: object = {}) => {
      try {
        parse(text, options)
      } catch (e: any) {
        return 'openapi_root' === e.code ? e.details.kind : e.code
      }
      return 'parsed'
    }
    for (const reading of ['base', 'spec']) {
      for (const text of ['', ' ', '\n\n', '\t\r\n', '# c', '  # c\n# d\n', '\uFEFF# c\n']) {
        assert.equal(kind(text, { reading }), 'empty', JSON.stringify(text))
      }
      // A marker, or null written out, is a document that holds null.
      for (const text of ['---\n', '~', 'null', '--- # c\n']) {
        assert.equal(kind(text, { reading }), 'null', JSON.stringify(text))
      }
      assert.equal(kind('- 1', { reading }), 'a list')
    }
    // What the reading takes for a comment decides the rest.
    assert.equal(kind('// c'), 'empty')
    assert.equal(kind('// c', { reading: 'spec' }), 'a string')
    // Strict JSON has no comment and no empty document.
    assert.equal(kind('', { strict: true }), 'unexpected')
    assert.equal(kind('# c', { strict: true }), 'unexpected')
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

// What `parse` decides from the text before the grammar builds any of it,
// what it reports beside the tree, and the function that goes with it.
describe('the text', () => {
  const code = (f: () => unknown) => {
    try {
      f()
    } catch (e: any) {
      return e.code ?? e.name
    }
    return 'parsed'
  }
  const bytesOf = (s: string) => new TextEncoder().encode(s)
  const cat = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => [...p]))
  const TEXT = 'openapi: 3.1.0\ninfo: {title: "é😀"}\n'
  const TREE = { openapi: '3.1.0', info: { title: 'é😀' } }

  test('bytes are read by their byte-order mark, and as UTF-8 without one', () => {
    assert.deepEqual(C(parse(bytesOf(TEXT))), TREE)
    assert.deepEqual(C(parse(cat([0xef, 0xbb, 0xbf], bytesOf(TEXT)))), TREE)
    assert.deepEqual(C(parse(Buffer.from(TEXT, 'utf8'))), TREE)

    // UTF-16 and UTF-32, in both byte orders, each behind its mark.
    const units = [...TEXT].flatMap((c) => (1 === c.length ? [c.charCodeAt(0)] : [c.charCodeAt(0), c.charCodeAt(1)]))
    const points = [...TEXT].map((c) => c.codePointAt(0)!)
    const le16 = units.flatMap((u) => [u & 255, u >> 8])
    const be16 = units.flatMap((u) => [u >> 8, u & 255])
    const le32 = points.flatMap((p) => [p & 255, (p >> 8) & 255, (p >> 16) & 255, p >>> 24])
    const be32 = points.flatMap((p) => [p >>> 24, (p >> 16) & 255, (p >> 8) & 255, p & 255])
    assert.deepEqual(C(parse(cat([0xff, 0xfe], le16))), TREE)
    assert.deepEqual(C(parse(cat([0xfe, 0xff], be16))), TREE)
    assert.deepEqual(C(parse(cat([0xff, 0xfe, 0, 0], le32))), TREE)
    assert.deepEqual(C(parse(cat([0, 0, 0xfe, 0xff], be32))), TREE)

    // Anything else is not a text.
    for (const not of [12, null, undefined, {}, new ArrayBuffer(4), [TEXT]]) {
      assert.throws(() => parse(not as any), TypeError)
    }
  })

  test('ill-formed bytes are read as U+FFFD, and refused under strict', () => {
    const bad = cat(bytesOf('{"openapi":"3.1.0","a":"x'), [0xff, 0xc0], bytesOf('y"}'))
    assert.deepEqual(C(parse(bad)), { openapi: '3.1.0', a: 'x\ufffd\ufffdy' })
    assert.throws(
      () => parse(bad, { strict: true }),
      (e: any) => 'openapi_encoding' === e.code && 'utf-8' === e.details.encoding,
    )
    // Half of a surrogate pair alone, and a byte left over at the end.
    assert.deepEqual(C(parse(cat([0xff, 0xfe], [0x61, 0, 0x3a, 0, 0x20, 0, 0x00, 0xd8, 0x0a, 0]))), { a: '\ufffd' })
    assert.deepEqual(C(parse(cat([0xff, 0xfe], [0x61, 0, 0x3a, 0, 0x20, 0, 0x22, 0], [0x22]))), { a: '\ufffd' })
    // A character past U+10FFFF.
    assert.deepEqual(C(parse(cat([0, 0, 0xfe, 0xff], [0, 0, 0, 0x61, 0, 0, 0, 0x3a, 0, 0, 0, 0x20, 0, 0x11, 0, 0]))), { a: '\ufffd' })
    assert.equal(code(() => parse(cat([0xff, 0xfe], [0x7b, 0, 0x7d, 0, 0x00, 0xd8]), { strict: true })), 'openapi_encoding')
    // Well-formed bytes are strict JSON like any other.
    assert.deepEqual(C(parse(bytesOf('{"openapi":"3.1.0"}'), { strict: true })), { openapi: '3.1.0' })
  })

  test('a byte-order mark is passed over, under strict too', () => {
    const text = '\uFEFF{"openapi":"3.1.0"}'
    for (const options of [{}, { fast: false }, { fast: true }, { strict: true }, { reading: 'spec' as const }]) {
      assert.deepEqual(C(parse(text, options)), { openapi: '3.1.0' })
    }
    assert.deepEqual(C(parse(cat([0xef, 0xbb, 0xbf], bytesOf('{"openapi":"3.1.0"}')), { strict: true })), { openapi: '3.1.0' })
    // An error after it is placed as the reader sees the text, without it.
    assert.throws(() => parse('\uFEFF{"openapi":"3.1.0",}', { strict: true }), (e: any) => 1 === e.lineNumber && 20 === e.columnNumber)

    // One mark is passed over and a second is text, as YAML reads it:
    // to the default reader it starts a plain scalar, so the root is a
    // string, or it is part of a member name. Strict JSON refuses it.
    const le16 = (text: string) => [...text].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])
    const twice: ((rest: string) => string | Uint8Array)[] = [
      (rest) => '\uFEFF\uFEFF' + rest,
      (rest) => cat([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], bytesOf(rest)),
      (rest) => cat([0xff, 0xfe, 0xff, 0xfe], le16(rest)),
    ]
    for (const two of twice) {
      assert.throws(() => parse(two('{"openapi":"3.1.0"}')), (e: any) => 'openapi_root' === e.code && 'a string' === e.details.kind)
      assert.deepEqual(C(parse(two('a: 1\n'))), { '\uFEFFa': 1 })
      assert.equal(code(() => parse(two('{"openapi":"3.1.0"}'), { strict: true })), 'unexpected')
    }
  })

  // Ten references to a list of ten, seven deep: 467 bytes that ask for
  // ten million nodes.
  const bomb = (levels: number) => {
    let text = 'openapi: 3.1.0\nl0: &l0 [x, x, x, x, x, x, x, x, x, x]\n'
    for (let i = 1; i <= levels; i++) text += `l${i}: &l${i} [${Array(10).fill('*l' + (i - 1)).join(', ')}]\n`
    return text
  }

  test('aliases that would copy the text out past the budget are refused before any is copied', () => {
    const text = bomb(7)
    assert.equal(text.length, 467)
    const started = Date.now()
    for (const options of [{}, { reading: 'spec' as const }, { fast: false }, { duplicates: 'merge' as const }]) {
      assert.throws(
        () => parse(text, options),
        (e: any) => 'openapi_alias_budget' === e.code && 444444447 === e.details.size && 1000000 === e.details.budget,
      )
    }
    assert.ok(Date.now() - started < 1000)

    // The default is the larger of a megabyte and ten times the text.
    assert.equal(aliasedSize(bomb(3)), 44451)
    assert.equal(Object.keys(parse(bomb(3))).length, 5)
    let wide = 'openapi: 3.1.0\nbase: &b [' + 'x, '.repeat(50000) + 'x]\n'
    for (let i = 0; i < 8; i++) wide += `u${i}: *b\n`
    assert.ok(1000000 < aliasedSize(wide) && aliasedSize(wide) < 10 * wide.length)
    assert.equal(parse(wide).u7.length, 50001)

    // A budget of the caller's own, and none.
    const small = 'base: &b {x: 1}\nuse: *b\n'
    assert.equal(aliasedSize(small), 33)
    assert.deepEqual(C(parse(small, { aliasBudget: 33 })), { base: { x: 1 }, use: { x: 1 } })
    assert.throws(() => parse(small, { aliasBudget: 32 }), (e: any) => 'openapi_alias_budget' === e.code && 32 === e.details.budget)
    assert.equal(Object.keys(parse(bomb(4), { aliasBudget: Infinity })).length, 6)
    for (const not of [-1, NaN, '9', null]) assert.throws(() => parse(small, { aliasBudget: not as any }), TypeError)

    // An ampersand and a star that are not an anchor and an alias cost
    // nothing, and only what aliases add is held to the budget: a text
    // in which none copies anything is never refused for it.
    const none = 'a: "x *y &z"\nb: x*y\n# *c &d\n'
    assert.equal(aliasedSize(none), 28)
    assert.equal(aliasedSize(none), Buffer.byteLength(none))
    assert.deepEqual(C(parse(none, { aliasBudget: 0 })), { a: 'x *y &z', b: 'x*y' })
    assert.deepEqual(C(parse('a: &never {x: 1}\nb: 2 * 3\n', { aliasBudget: 0 })), { a: { x: 1 }, b: '2 * 3' })
    assert.equal(code(() => parse(small, { aliasBudget: 0 })), 'openapi_alias_budget')
    assert.deepEqual(C(parse('{"openapi":"3.1.0","a":"&x *x"}', { strict: true })), { openapi: '3.1.0', a: '&x *x' })
  })

  test('a text too large for the grammar is refused, unless JSON.parse reads it', () => {
    const yaml = 'openapi: 3.1.0\ninfo: {}\n'
    const json = '{"openapi":"3.1.0","info":{}}'
    assert.throws(() => parse(yaml, { maxBytes: 23 }), (e: any) => 'openapi_size' === e.code && 24 === e.details.size && 23 === e.details.limit)
    assert.deepEqual(C(parse(yaml, { maxBytes: 24 })), { openapi: '3.1.0', info: {} })
    assert.deepEqual(C(parse(json, { maxBytes: 1 })), { openapi: '3.1.0', info: {} })
    assert.equal(code(() => parse(json, { maxBytes: 1, fast: false })), 'openapi_size')
    assert.equal(code(() => parse(json, { maxBytes: 1, strict: true })), 'openapi_size')
    assert.equal(code(() => parse(json, { maxBytes: 1, duplicates: 'merge' })), 'openapi_size')
    // The size is in bytes of UTF-8, of a string as of its bytes.
    assert.equal(code(() => parse('a: é\n', { maxBytes: 5 })), 'openapi_size')
    assert.equal(code(() => parse(bytesOf('a: é\n'), { maxBytes: 5 })), 'openapi_size')
    assert.deepEqual(C(parse('a: é\n', { maxBytes: 6 })), { a: 'é' })
    // Bytes that are not well-formed are measured as the text they are
    // read as: here five bytes, of which one becomes U+FFFD, three bytes.
    const bad = new Uint8Array([0x61, 0x3a, 0x20, 0xff, 0x0a])
    assert.throws(() => parse(bad, { maxBytes: 6 }), (e: any) => 'openapi_size' === e.code && 7 === e.details.size)
    assert.deepEqual(C(parse(bad, { maxBytes: 7 })), { a: '\ufffd' })
    // A byte-order mark is not part of the text, and is not counted.
    assert.deepEqual(C(parse(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x3a, 0x20, 0x31, 0x0a]), { maxBytes: 5 })), { a: 1 })
    assert.equal(code(() => parse(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x3a, 0x20, 0x31, 0x0a]), { maxBytes: 4 })), 'openapi_size')
    for (const not of [-1, NaN, '9', null]) assert.throws(() => parse(yaml, { maxBytes: not as any }), TypeError)

    // Without the option the limit is 16 MiB, and Infinity lifts it.
    const filler = 'x'.repeat(16 * 1024 * 1024)
    assert.throws(
      () => parse('openapi: 3.1.0\na: ' + filler + '\n'),
      (e: any) => 'openapi_size' === e.code && 16 * 1024 * 1024 === e.details.limit,
    )
    assert.equal(parse('{"openapi":"3.1.0","a":"' + filler + '"}').a.length, filler.length)
    assert.equal(parse('openapi: 3.1.0\na: ' + 'x'.repeat(70000) + '\n', { maxBytes: Infinity }).a.length, 70000)
  })

  test('a report lists the numbers the tree does not hold exactly, each with its place', () => {
    const lossy = (text: string, options: object = {}) => {
      const report: ParseReport = {}
      parse(text, { ...options, report })
      return report.lossy
    }
    const yaml = [
      'openapi: 3.1.0',
      'max: 9223372036854775807',
      'ok: 9007199254740992',
      'list:',
      '  - 1',
      '  - 9007199254740993',
      '  - {deep: -9007199254740993}',
      'big: 1e400',
      'hex: 0x20000000000001',
      'inf: .inf',
      'text: "9007199254740993"',
      'float: 0.12345678901234567890',
      '',
    ].join('\n')
    const pos = (text: string) => yaml.indexOf(text)
    assert.deepEqual(lossy(yaml), [
      { text: '9223372036854775807', value: 9223372036854775807, pos: pos('9223'), row: 2, col: 6, at: '/max' },
      { text: '9007199254740993', value: 9007199254740992, pos: pos('9007199254740993'), row: 6, col: 5, at: '/list/1' },
      { text: '-9007199254740993', value: -9007199254740992, pos: pos('-9007'), row: 7, col: 12, at: '/list/2/deep' },
      { text: '1e400', value: Infinity, pos: pos('1e400'), row: 8, col: 6, at: '/big' },
      { text: '0x20000000000001', value: 9007199254740992, pos: pos('0x2'), row: 9, col: 6, at: '/hex' },
    ])
    assert.equal(pos('9223'), 20)
    // Each place is where the text has the number, whatever comes before:
    // a block scalar, a quoted scalar over two lines, a line that ends
    // with a carriage return and a line feed, a character outside the
    // basic plane.
    const placed = 'a: |\n  block\n\nb: "two\n  lines"\r\nc😀: {d: 9007199254740993}\r\ne: 9007199254740993\n'
    for (const l of lossy(placed)!) assert.equal(placed.substr(l.pos, l.text.length), l.text)
    assert.deepEqual(lossy(placed)!.map((l) => [l.row, l.col, l.at]), [[6, 10, '/c😀/d'], [7, 4, '/e']])

    // JSON text is read by the grammar when it may hold one, and by
    // JSON.parse when it cannot.
    const json = '{"openapi":"3.1.0","a":[1,{"b":9007199254740993}],"c":1e999,"d":"9007199254740993000"}'
    for (const options of [{}, { fast: true }, { fast: false }, { strict: true }, { reading: 'spec' as const }]) {
      assert.deepEqual(lossy(json, options), [
        { text: '9007199254740993', value: 9007199254740992, pos: 31, row: 1, col: 32, at: '/a/1/b' },
        { text: '1e999', value: Infinity, pos: 54, row: 1, col: 55, at: '/c' },
      ])
    }
    assert.deepEqual(lossy('{"openapi":"3.1.0","a":12}'), [])
    assert.deepEqual(lossy('a: 12\n'), [])

    // What each reading takes for a number decides what can be lossy.
    const forms = 'a: 9_007_199_254_740_993\nb: 0b100000000000000000000000000000000000000000000000000001\nc: 012345678901234567890\nd: Infinity\n'
    assert.deepEqual(lossy(forms)!.map((l) => l.at), ['/a', '/b', '/c'])
    assert.deepEqual(lossy(forms, { reading: 'spec' })!.map((l) => l.at), ['/c'])

    // An alias copies its anchor's node, and the anchor's place is the one
    // reported. Of a repeated member name, the value the tree does not
    // keep has no place in it.
    assert.deepEqual(
      lossy('a: &n 9007199254740993\nb: *n\nc: &m {x: 9007199254740993}\nd: {<<: *m}\n')!.map((l) => [l.at, l.row]),
      [['/a', 1], ['/c/x', 3]],
    )
    assert.deepEqual(lossy('a: 9007199254740993\na: 5\n'), [{ text: '9007199254740993', value: 9007199254740992, pos: 3, row: 1, col: 4 }])
    assert.deepEqual(lossy('a: 5\na: 9007199254740993\n')!.map((l) => l.at), ['/a'])
    // A place in a block list, in a list of lists, and under a key with a slash.
    assert.deepEqual(
      lossy('l:\n  - - 1\n    - 9007199254740993\n  - x: 9007199254740993\n    y/z: [0, 9007199254740993]\n')!.map((l) => l.at),
      ['/l/0/1', '/l/1/x', '/l/1/y~1z/1'],
    )

    // The tree is the same with a report as without, and a parse with no
    // report makes none.
    assert.deepEqual(C(parse(json, { report: {} })), C(parse(json)))
    for (const not of [[], 'x', null, 1]) assert.throws(() => parse('a: 1', { report: not as any }), TypeError)
  })

  test('wellFormed reads every lone surrogate as U+FFFD, in strings and in member names', () => {
    const text = '{"a\\ud800":{"x":1},"a\\ufffd":{"y":2},"b":"c\\udc00d","ok":"\\ud83d\\ude00","l":["\\ud800",{"k\\udfff":1}]}'
    const tree = parse(text)
    const before = JSON.stringify(tree)
    // Two names the repair makes one keep the later value, or merge.
    assert.deepEqual(C(wellFormed(tree)), { 'a\ufffd': { y: 2 }, b: 'c\ufffdd', ok: '😀', l: ['\ufffd', { 'k\ufffd': 1 }] })
    assert.deepEqual(C(wellFormed(tree, { duplicates: 'merge' }))['a\ufffd'], { x: 1, y: 2 })
    assert.equal(JSON.stringify(tree), before)
    assert.deepEqual(Object.keys(wellFormed(tree)), ['a\ufffd', 'b', 'ok', 'l'])
    assert.equal(Object.getPrototypeOf(wellFormed(tree)), null)
    assert.equal(Object.getPrototypeOf(wellFormed({ a: '\ud800' })), Object.prototype)

    // A tree with nothing to repair is itself, and so is a value that is no tree.
    const clean = parse('a: {b: [1, "😀"]}')
    assert.equal(wellFormed(clean), clean)
    assert.equal(wellFormed('x\ud800'), 'x\ufffd')
    assert.equal(wellFormed(12), 12)
    assert.equal(wellFormed(null), null)

    // What was shared stays shared, and a cycle stays a cycle.
    const shared = { s: '\udc00' }
    const graph: any = { a: shared, b: shared, list: [shared] }
    graph.self = graph
    const out: any = wellFormed(graph)
    assert.equal(out.a, out.b)
    assert.equal(out.list[0], out.a)
    assert.equal(out.self, out)
    assert.equal(out.a.s, '\ufffd')
    assert.equal(graph.a.s, '\udc00')

    // A member named __proto__ is data.
    const proto = wellFormed(parse('{"__proto__":{"x":"\\ud800"}}'))
    assert.deepEqual(Object.keys(proto), ['__proto__'])
    assert.equal(proto.__proto__.x, '\ufffd')
    assert.throws(() => wellFormed(tree, { duplicates: 'first' as any }), TypeError)
  })

  test('a deep tree does not exhaust the stack in wellFormed', () => {
    let deep: any = { leaf: '\ud800' }
    for (let i = 0; i < 200000; i++) deep = 0 === i % 2 ? [deep] : { k: deep }
    let out: any = wellFormed(deep)
    for (let i = 0; i < 200000; i++) out = Array.isArray(out) ? out[0] : out.k
    assert.equal(out.leaf, '\ufffd')
  })

  test('a shared parser lets go of a large parse once it has returned', () => {
    // A parser holds the whole of its last parse, about a hundred times
    // the text, until its next parse starts. `parse` makes its own parsers
    // let go. This runs in a process of its own, where the heap can be
    // measured after a collection.
    const script = `
      const { parse } = require(${JSON.stringify(join(__dirname, '..', 'dist', 'openapi.js'))})
      let text = 'openapi: 3.1.0\\n'
      for (let i = 0; i < 30000; i++) text += 'k' + i + ': {a: 1, b: [x, y], c: "some text"}\\n'
      const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
      const start = heap()
      let tree = parse(text)
      const members = Object.keys(tree).length
      tree = null
      console.log(JSON.stringify({ bytes: text.length, members, heldMB: (heap() - start) / 1048576 }))
    `
    const run = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const { bytes, members, heldMB } = JSON.parse(run.stdout)
    assert.equal(members, 30001)
    assert.ok(1000000 < bytes)
    // Unreleased, a text this size leaves more than a hundred megabytes held.
    assert.ok(heldMB < 20, `the shared parser still holds ${heldMB.toFixed(1)} MB`)
  })
})
