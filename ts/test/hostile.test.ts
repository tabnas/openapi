/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// Texts built to cost more than their size.
//
// `parse` reads text from outside a system, so what it does to a text
// before the grammar runs has to be one pass over it, or a counted amount
// of work. Each test here is a shape that made one of those checks take
// time or memory that grew with the square of the text, and holds it to
// a bound: a code, or an answer, in a time a person would not notice.
//
// The time limits are loose on purpose. Each shape took minutes or ran
// out of memory before its bound was there, so a limit of seconds tells
// the two apart on any machine.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { aliasedSize, make, parse } from '../dist/openapi'
import type { ParseReport } from '../dist/openapi'
import { decode, hasContent, utf8Length } from '../dist/text'
import { measure } from '../dist/yaml-alias'

const SECONDS = 1000

// The milliseconds a call takes, and what it gave or threw.
function timed<T>(f: () => T): { ms: number; value?: T; error?: any } {
  const started = process.hrtime.bigint()
  try {
    const value = f()
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, value }
  } catch (error) {
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, error }
  }
}

// A generator of numbers that gives the same run every time.
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

const bytesOf = (s: string) => new TextEncoder().encode(s)

describe('hostile: the test for an empty text', () => {
  // The pattern apidef tests an empty source with. `hasContent` is that
  // test made in one pass.
  const PATTERN = /^\s*[^#\s]/m

  test('it is the pattern, on every short text of the characters that matter', () => {
    const alphabet = [' ', '\t', '\n', '\r', '#', 'a', '-', ' ', ' ', '﻿', ' ', '\v']
    const random = seeded(7)
    let differ = 0
    for (let n = 0; n < 40000; n++) {
      let text = ''
      const length = Math.floor(random() * 10)
      for (let i = 0; i < length; i++) text += alphabet[Math.floor(random() * alphabet.length)]
      if (hasContent(text) !== PATTERN.test(text)) differ++
    }
    assert.equal(differ, 0)
    for (const text of ['', ' ', '#', '# a\n# b', '\n\n# a\n  b', 'a', ' #a\n\t#b\r\n', '#a\rb', '#a b', '﻿# a']) {
      assert.equal(hasContent(text), PATTERN.test(text), JSON.stringify(text))
    }
  })

  test('a long run of blank lines is read once', () => {
    // The pattern reads the run again from each of its lines: 160,000
    // line breaks took it 17 seconds, and a million would take it ten
    // minutes.
    const blank = '\n'.repeat(1000000)
    for (const text of [blank, blank + '# a comment\n', blank + '# a comment\nopenapi: 3.1.0\n', ' \n'.repeat(500000)]) {
      const r = timed(() => hasContent(text))
      assert.ok(r.ms < 5 * SECONDS, `${Math.round(r.ms)} ms`)
      assert.equal(r.value, text.includes('openapi'))
    }
  })

  test('parse says a text of blank lines is empty, in a time that follows its size', () => {
    const r = timed(() => parse('\n'.repeat(200000) + '# nothing here\n'))
    assert.equal(r.error?.code, 'openapi_root')
    assert.equal(r.error?.details.kind, 'empty')
    assert.ok(r.ms < 20 * SECONDS, `${Math.round(r.ms)} ms`)
  })
})

describe('hostile: the alias measure', () => {
  // Every shape below is measured as past all bounds, quickly, and
  // `parse` refuses it with the code an alias bomb gets.
  const refused = (text: string) => {
    const measured = timed(() => aliasedSize(text))
    assert.equal(measured.value, Infinity)
    assert.ok(measured.ms < 5 * SECONDS, `measured in ${Math.round(measured.ms)} ms`)
    const parsed = timed(() => parse(text))
    assert.equal(parsed.error?.code, 'openapi_alias_budget')
    assert.equal(parsed.error?.details.size, Infinity)
    assert.equal(parsed.error?.details.budget, Math.max(1000000, 10 * Buffer.byteLength(text)))
    assert.ok(parsed.ms < 5 * SECONDS, `refused in ${Math.round(parsed.ms)} ms`)
  }

  test('anchors nested in flow, each holding every alias', () => {
    // Each anchor's size is a sum over the aliases inside it, so 3,000
    // anchors around 3,000 aliases ask for nine million steps.
    const n = 3000
    const open = Array.from({ length: n }, (_, i) => `&a${i} [`).join('')
    refused('base: &z x\nv: ' + open + Array(n).fill('*z').join(', ') + ']'.repeat(n) + '\n')
  })

  test('anchors by the thousand on one line', () => {
    // Each anchor's scalar is found by reading on to the end of the line.
    refused('k: ' + '&a '.repeat(20000) + 'x\nuse: *a\n')
  })

  test('block anchors nested by indentation', () => {
    // Each anchor's block is found by reading on to where the indentation
    // returns, which here is the end of the text for every one of them.
    let text = ''
    const n = 600
    for (let i = 0; i < n; i++) text += ' '.repeat(i) + `k${i}: &b${i}\n`
    refused(text + ' '.repeat(n) + 'v: 1\nuse: *b0\n')
  })

  test('anchors that each hold an alias to themselves, nested', () => {
    // A size that is asked for while it is being worked out is nothing,
    // and each level here asks for the next: 200 levels deep.
    let text = ''
    const n = 200
    for (let i = 0; i < n; i++) text += ' '.repeat(i) + `a${i}: &a${i}\n` + ' '.repeat(i + 1) + `r${i}: *a${i}\n`
    refused(text)
  })

  test('a real description, with anchors and aliases by the thousand, costs little', () => {
    const block = (i: number) => `&s${i}\n      type: object\n      properties: {a: {type: string}, b: {type: integer}}\n`
    let text = 'openapi: 3.1.0\ncomponents:\n  schemas:\n'
    const anchors = 300
    const aliases = 3000
    let added = 0
    for (let i = 0; i < anchors; i++) text += `    S${i}: ` + block(i)
    text += 'paths:\n'
    for (let i = 0; i < aliases; i++) {
      text += `  /p${i}: {get: {responses: {'200': {content: {application/json: {schema: *s${i % anchors}}}}}}}\n`
      added += block(i % anchors).length
    }
    const bytes = bytesOf(text)
    const m = measure(bytes)
    assert.equal(m.size, bytes.length + added)
    assert.equal(aliasedSize(text), m.size)
    // The measure allows thirty-two steps for each byte, and a million.
    assert.ok(m.work < bytes.length, `${m.work} steps for ${bytes.length} bytes`)
    assert.equal(Object.keys(parse(text).paths).length, aliases)
  })
})

describe('hostile: a text of very many small values', () => {
  // The grammar keeps about a kilobyte for each rule pass until it is
  // done. A description takes a pass for each ten bytes. A text of small
  // values takes one or two for each byte, so a megabyte and a half of
  // them took more memory than a process has by default, far under the
  // size limit. The limit also bounds the passes, and these are stopped.
  const dense: Record<string, (bytes: number) => string> = {
    'items in a flow list': (bytes) => 'a: [' + 'x,'.repeat(bytes / 2) + 'x]\n',
    'empty items': (bytes) => 'l:\n' + '-\n'.repeat(bytes / 2),
    'small maps': (bytes) => 'base:\n' + '  - {a: x}\n'.repeat(bytes / 11),
    'members': (bytes) => Array.from({ length: bytes / 9 }, (_, i) => `k${i}: v\n`).join(''),
    'JSON items': (bytes) => '{"a":[' + '1,'.repeat(bytes / 2) + '1]}',
  }

  test('each shape is stopped by the work it takes, under the size limit', () => {
    const limit = 1048576
    for (const [shape, text] of Object.entries(dense)) {
      const source = text(600000)
      assert.ok(Buffer.byteLength(source) < limit, shape)
      for (const options of 'JSON items' === shape ? [{ fast: false }, { strict: true }] : [{}, { reading: 'spec' as const }]) {
        const r = timed(() => parse(source, { ...options, maxBytes: limit }))
        assert.equal(r.error?.code, 'openapi_work', shape)
        assert.deepEqual(r.error.details, { steps: 104857, limit }, shape)
        assert.ok(r.ms < 10 * SECONDS, `${shape}: ${Math.round(r.ms)} ms`)
      }
    }
    // JSON that JSON.parse reads takes no work of the grammar's.
    assert.equal(parse(dense['JSON items'](600000), { maxBytes: limit }).a.length, 300001)
    // A description of the same size, most of whose bytes are the words
    // of its descriptions, takes a fraction of the steps, and is read.
    const words = 'Lists the pets of one owner, newest first, a page at a time. '.repeat(6)
    let description = 'openapi: 3.1.0\npaths:\n'
    for (let i = 0; description.length < 600000; i++) {
      description += `  /pets/${i}:\n    get:\n      description: ${words}\n      responses:\n        '200': {description: ${words}}\n`
    }
    assert.ok(600 < Object.keys(parse(description, { maxBytes: limit }).paths).length)
    // A small limit still gives a small text a hundred thousand steps.
    assert.equal(parse(dense['small maps'](55000), { maxBytes: 200000 }).base.length, 5000)
    assert.deepEqual(timed(() => parse(dense['small maps'](190000), { maxBytes: 200000 })).error?.details, { steps: 100000, limit: 200000 })
    // And no limit, no bound on the work.
    assert.equal(parse(dense['small maps'](190000), { maxBytes: Infinity }).base.length, 17272)
  })

  test('at the default limit, a text that exhausted memory is refused in a process of its own', () => {
    // Six megabytes of small items, a third of the size limit. Before the
    // work was bounded this ended the process. It runs in a child so that
    // an end of that kind fails the test and not the run.
    const script = `
      const { parse } = require(${JSON.stringify(join(__dirname, '..', 'dist', 'openapi.js'))})
      let out
      try { parse('a: [' + 'x,'.repeat(3000000) + 'x]\\n'); out = 'parsed' } catch (e) { out = e.code + ' ' + JSON.stringify(e.details) }
      console.log(out)
    `
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 120 * SECONDS })
    assert.equal(child.status, 0, child.stderr.split('\n').slice(0, 3).join(' | '))
    assert.equal(child.stdout.trim(), 'openapi_work {"steps":1677721,"limit":16777216}')
  })
})

describe('hostile: aliases the measure does not see', () => {
  // Ten references to a list of ten, as many levels deep as asked for.
  const chain = (levels: number, pad: string) => {
    let text = `${pad}l0: &l0 [x, x, x, x, x, x, x, x, x, x]\n`
    for (let i = 1; i <= levels; i++) text += `${pad}l${i}: &l${i} [${Array(10).fill('*l' + (i - 1)).join(', ')}]\n`
    return text
  }

  // The measure reads a text as YAML. The base reading also has the
  // comments of JSON with comments, and a `|` inside one of those is to
  // the measure the start of a block scalar, which hides every line
  // indented past it. The grammar reads the lines and copies.
  const hidden = ['components: /*\n|\n  */\n', 'components:\n  a: /*\n|\n  */ 1\n']

  test('copies behind a comment only the base reading has are held to the budget as they are made', () => {
    for (const head of hidden) {
      const text = head + chain(7, '  ')
      // The measure sees no alias at all.
      assert.equal(aliasedSize(text), Buffer.byteLength(text))
      const r = timed(() => parse(text))
      assert.equal(r.error?.code, 'openapi_alias_budget')
      assert.equal(r.error.details.budget, 1000000)
      // Stopped at the copy that passed the budget, not ten million items on.
      assert.ok(1000000 < r.error.details.size && r.error.details.size < 1200000, String(r.error.details.size))
      // Placed at the alias whose copy passed it.
      assert.ok(8 < r.error.lineNumber, String(r.error.lineNumber))
      assert.ok(r.ms < 10 * SECONDS, `${Math.round(r.ms)} ms`)
      // Under the specification's reading there is no such comment, and
      // the text is not YAML.
      assert.equal(timed(() => parse(text, { reading: 'spec' })).error?.code, 'unexpected')
    }
  })

  test('the caller\'s own budget holds them too, and no budget lets them by', () => {
    for (const head of hidden) {
      const text = head + chain(2, '  ')
      assert.equal(aliasedSize(text), Buffer.byteLength(text))
      const whole = parse(text, { aliasBudget: Infinity })
      assert.equal(whole.components.l2.length, 10)
      assert.equal(whole.components.l2[9].length, 10)
      assert.deepEqual(parse(text, { aliasBudget: 100000 }), whole)
      const r = timed(() => parse(text, { aliasBudget: 500 }))
      assert.equal(r.error?.code, 'openapi_alias_budget')
      assert.deepEqual(r.error.details, { size: 501, budget: 500 })
      // A budget under the size of the text allows no copy at all.
      assert.equal(timed(() => parse(text, { aliasBudget: 0 })).error?.code, 'openapi_alias_budget')
    }
  })

  test('a tag between an anchor and its collection does not hide what the collection holds', () => {
    const maps = (tag: string, levels: number) => {
      let text = `l0: &l0 ${tag}{\n  a: x, b: x, c: x, d: x, e: x\n}\n`
      for (let i = 1; i <= levels; i++) {
        text += `l${i}: &l${i} ${tag}{\n  ${Array.from({ length: 10 }, (_, k) => `k${k}: *l${i - 1}`).join(', ')}\n}\n`
      }
      return text
    }
    // Three levels are read, and the measure of each spelling is near the other's.
    const plain = aliasedSize(maps('', 3))
    const tagged = aliasedSize(maps('!!map ', 3))
    assert.ok(50000 < plain && plain < tagged && tagged < 1.2 * plain, `${plain} and ${tagged}`)
    assert.deepEqual(parse(maps('!!map ', 3), { aliasBudget: Infinity }), parse(maps('', 3), { aliasBudget: Infinity }))
    // Seven are refused before anything is built.
    const r = timed(() => parse(maps('!!map ', 7)))
    assert.equal(r.error?.code, 'openapi_alias_budget')
    assert.ok(100000000 < r.error.details.size, String(r.error.details.size))
    assert.deepEqual([r.error.lineNumber, r.error.columnNumber], [1, 1])
    // A block node behind a tag, and a scalar behind one.
    assert.equal(aliasedSize('a: &a !!map\n  x: 1\n  y: 2\nb: *a\n'), 32 + 23)
    assert.equal(aliasedSize('a: &a !!str x\nb: *a\n'), 20 + 10)
  })

  test('the count of copies never passes the measure of a text the measure reads rightly', () => {
    // The budget is set to the measure itself, the least that lets the
    // text by: the copies, counted from below, must fit in it.
    const random = seeded(23)
    const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]
    const names = ['a', 'b', 'c', 'd']
    const node = (depth: number): string =>
      0 === depth || random() < 0.4
        ? pick(['x', '12', '"q r"', 'true', "'s'", '~', '""'])
        : random() < 0.5
          ? `[${Array.from({ length: 1 + Math.floor(random() * 3) }, () => node(depth - 1)).join(', ')}]`
          : `{${Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => `k${i}: ${node(depth - 1)}`).join(', ')}}`
    let read = 0
    for (let n = 0; n < 3000; n++) {
      let text = ''
      const anchored: string[] = []
      const lines = 2 + Math.floor(random() * 6)
      for (let i = 0; i < lines; i++) {
        const name = pick(names)
        if (0 < anchored.length && random() < 0.5) {
          text += random() < 0.5 ? `m${i}: *${pick(anchored)}\n` : `m${i}: [*${pick(anchored)}, {z: *${pick(anchored)}}]\n`
        } else if (random() < 0.3) {
          text += `m${i}: &${name}\n  p: ${node(1)}\n  q:\n    - ${node(1)}\n    - ${0 < anchored.length ? '*' + pick(anchored) : 'y'}\n`
          anchored.push(name)
        } else {
          text += `m${i}: &${name} ${node(2)}\n`
          anchored.push(name)
        }
      }
      let whole: unknown
      try {
        whole = parse(text, { aliasBudget: Infinity })
      } catch {
        continue
      }
      read++
      assert.deepEqual(parse(text, { aliasBudget: aliasedSize(text) }), whole, JSON.stringify(text))
    }
    assert.ok(2000 < read, `${read} read`)
  })
})

describe('hostile: the places of a report', () => {
  test('numbers deep in a tree are all listed, and placed while the steps last', () => {
    // A place costs a step for each level above the number: for each
    // container on the fast path, and for each rule on the grammar's.
    // Numbers by the hundred under 3,000 lists would cost millions of
    // steps, and a list of paths that long would not fit in memory at
    // ten times the size.
    const depth = 3000
    for (const [options, count] of [[{}, 1000], [{ fast: false }, 400]] as [object, number][]) {
      const text = '{"a":' + '['.repeat(depth) + Array(count).fill('9007199254740993').join(',') + ']'.repeat(depth) + '}'
      const report: ParseReport = {}
      const r = timed(() => parse(text, { ...options, report }))
      assert.equal(r.error, undefined)
      assert.ok(r.ms < 20 * SECONDS, `${Math.round(r.ms)} ms`)
      const lossy = report.lossy!
      assert.equal(lossy.length, count)
      assert.ok(lossy.every((l) => '9007199254740993' === l.text && 9007199254740992 === l.value))
      assert.equal(lossy[0].at, '/a' + '/0'.repeat(depth))
      assert.equal(lossy[1].at, '/a' + '/0'.repeat(depth - 1) + '/1')
      assert.equal(lossy[count - 1].at, undefined)
      const placed = lossy.filter((l) => undefined !== l.at).length
      assert.ok(100 < placed && placed < count, `${placed} placed`)
      // The places come first: none follows a number that has none.
      assert.equal(lossy.findIndex((l) => undefined === l.at), placed)
    }
  })

  test('a real document has every place', () => {
    let text = 'openapi: 3.1.0\ncomponents:\n  schemas:\n'
    for (let i = 0; i < 2000; i++) text += `    S${i}: {type: integer, maximum: 9223372036854775807}\n`
    const report: ParseReport = {}
    parse(text, { report })
    assert.equal(report.lossy!.length, 2000)
    assert.equal(report.lossy![1999].at, '/components/schemas/S1999/maximum')
    assert.ok(report.lossy!.every((l) => undefined !== l.at))
  })
})

describe('hostile: a refusal', () => {
  // A parser that counts the characters its lexer is given.
  const counting = () => {
    const tn = make()
    const seen = { characters: 0 }
    tn.sub({
      lex: (tkn: { src?: unknown }) => {
        if ('string' === typeof tkn.src) seen.characters += tkn.src.length
      },
    })
    return { tn, seen }
  }
  const diagnostic = (error: unknown) => JSON.parse(JSON.stringify(error))

  test('a text refused for its size is not handed to the grammar', () => {
    // Handing a text over costs three times its size in memory before
    // the first rule runs. A refused text costs its opening lines.
    const text = 'openapi: 3.1.0\ninfo: {title: T}\n' + 'x-pad: 0123456789\n'.repeat(200000)
    const { tn, seen } = counting()
    const r = timed(() => parse(text, { instance: tn, maxBytes: 1000 }))
    assert.equal(r.error?.code, 'openapi_size')
    assert.equal(r.error.details.size, text.length)
    assert.ok(seen.characters <= 240, `${seen.characters} characters lexed`)
    assert.ok(r.ms < 5 * SECONDS, `${Math.round(r.ms)} ms`)
    // The error is placed at the start of the text, and shows its lines.
    assert.deepEqual([r.error.lineNumber, r.error.columnNumber], [1, 1])
    assert.equal(diagnostic(r.error).src, 'openapi: 3.1.0')
    assert.ok(r.error.message.includes('info: {title: T}'))
    // The parser reads the next text as if nothing had happened.
    assert.deepEqual(JSON.parse(JSON.stringify(parse('a: 1\n', { instance: tn }))), { a: 1 })
  })

  test('nor is a text whose aliases are past the budget', () => {
    let text = 'openapi: 3.1.0\nl0: &l0 [x, x, x, x, x, x, x, x, x, x]\n'
    for (let i = 1; i <= 7; i++) text += `l${i}: &l${i} [${Array(10).fill('*l' + (i - 1)).join(', ')}]\n`
    const { tn, seen } = counting()
    const r = timed(() => parse(text, { instance: tn }))
    assert.equal(r.error?.code, 'openapi_alias_budget')
    assert.ok(seen.characters <= 240, `${seen.characters} characters lexed`)
    assert.equal(diagnostic(r.error).src, 'openapi: 3.1.0')
  })

  test('a text whose opening does not start a parse by itself still gets its code', () => {
    const code = (f: () => unknown) => timed(f).error?.code
    // Strict JSON that opens with a token longer than the opening.
    assert.equal(code(() => parse('"' + 'x'.repeat(1000) + '"', { strict: true, maxBytes: 100 })), 'openapi_size')
    assert.equal(code(() => parse('\n\n\n\n{"openapi":"3.1.0"}', { strict: true, maxBytes: 10 })), 'openapi_size')
    // One long line, cut where a surrogate pair would be split.
    assert.equal(code(() => parse('a: ' + 'x'.repeat(236) + '😀'.repeat(100), { maxBytes: 100 })), 'openapi_size')
    assert.equal(code(() => parse('😀'.repeat(200), { maxBytes: 100 })), 'openapi_size')
    // Bytes that are not well-formed, under strict.
    const bad = new Uint8Array(2000).fill(0x22)
    bad[1] = 0xff
    assert.equal(code(() => parse(bad, { strict: true })), 'openapi_encoding')
  })
})

describe('hostile: the size and the bytes of a text', () => {
  test('the size in bytes is the size an encoder gives', () => {
    const pieces = ['a', 'é', '€', '😀', '\ud800', '\udc00', '\ud83d', '\n', '߿', 'ࠀ', '￿']
    const random = seeded(11)
    for (let n = 0; n < 5000; n++) {
      let text = ''
      const length = Math.floor(random() * 8)
      for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)]
      assert.equal(utf8Length(text), Buffer.byteLength(text), JSON.stringify(text))
    }
  })

  test('bytes by the million are decoded in one pass', () => {
    const utf16 = new Uint8Array(2 + 2 * 3000000)
    utf16[0] = 0xff
    utf16[1] = 0xfe
    for (let i = 2; i < utf16.length; i += 2) utf16[i] = 0x61
    const r = timed(() => decode(utf16))
    assert.equal(r.value!.text.length, 3000000)
    assert.equal(r.value!.illFormed, false)
    assert.ok(r.ms < 10 * SECONDS, `${Math.round(r.ms)} ms`)
    // Every byte ill-formed: each is read as U+FFFD, and the text is
    // measured as it is read.
    const bad = new Uint8Array(1000000).fill(0xff)
    const d = decode(bad)
    assert.equal(d.illFormed, true)
    assert.equal(d.text.length, 1000000)
    assert.equal(utf8Length(d.text), 3000000)
  })
})
