/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The readers of runtime expressions and templates against
// test/expression/*.tsv. Each file has its own columns:
//
//   expression-read.tsv   input, expected: what readExpression gives
//   template-read.tsv     input, expected, kind: what readTemplate gives
//   expression-eval.tsv   input, expected, exchange, kind: the value
//                         evaluateExpression gives, UNDEFINED for none
//
// `ERROR:openapi_expression` in expected is text the reader refuses.
// These fixtures live outside test/spec/ because the parity runners
// there read a parse, and the other implementations do not have the
// readers yet.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadSpec } from '@tabnas/support'

import { ExpressionError, evaluateExpression, readExpression, readTemplate } from '../dist/openapi'
import type { TemplateKind } from '../dist/openapi'

const DIR = join(__dirname, '..', '..', 'test', 'expression')

const refused = (run: () => unknown, where: string) =>
  assert.throws(
    run,
    (err: any) => err instanceof ExpressionError && 'openapi_expression' === err.code && 'number' === typeof err.offset,
    where + ' should raise openapi_expression',
  )

type Runner = (row: any, where: string) => void

const RUNNERS: Record<string, Runner> = {
  'expression-read.tsv': (row, where) => {
    const input = row.unescNamed('input')
    const expected = row.named('expected')
    if (expected.startsWith('ERROR:')) return refused(() => readExpression(input), where)
    assert.deepStrictEqual(readExpression(input), JSON.parse(expected), where)
  },
  'template-read.tsv': (row, where) => {
    const input = row.unescNamed('input')
    const expected = row.named('expected')
    const kind = row.named('kind') as TemplateKind
    if (expected.startsWith('ERROR:')) return refused(() => readTemplate(input, kind), where)
    assert.deepStrictEqual(readTemplate(input, kind), JSON.parse(expected), where)
  },
  'expression-eval.tsv': (row, where) => {
    const input = row.unescNamed('input')
    const expected = row.named('expected')
    const exchange = JSON.parse(row.named('exchange'))
    const kind = row.named('kind')
    const value = evaluateExpression('' === kind ? input : readTemplate(input, kind as TemplateKind), exchange)
    if ('UNDEFINED' === expected) assert.strictEqual(value, undefined, where)
    else assert.deepStrictEqual(value, JSON.parse(expected), where)
  },
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.tsv'))
  .sort()

test('every expression fixture has a runner, and every runner a fixture', () => {
  assert.deepStrictEqual(files, Object.keys(RUNNERS).sort())
})

for (const file of files) {
  const run = RUNNERS[file]
  if (undefined === run) continue
  const spec = loadSpec(join(DIR, file))
  describe('expression: ' + file, () => {
    test('has rows', () => {
      assert.ok(0 < spec.rows.length, file + ' has no rows')
    })
    for (const row of spec.rows) {
      test(`row ${row.line}: ${JSON.stringify(row.unescNamed('input')).slice(0, 60)}`, () => run(row, `${file}:${row.line}`))
    }
  })
}

describe('expression: what a fixture cannot say', () => {
  test('an error says where reading stopped', () => {
    try {
      readExpression('$request.header.a b')
      assert.fail('read')
    } catch (err: any) {
      assert.ok(err instanceof ExpressionError)
      assert.equal(err.name, 'ExpressionError')
      assert.equal(err.code, 'openapi_expression')
      assert.equal(err.text, '$request.header.a b')
      assert.equal(err.offset, 17)
      assert.match(err.message, /a header name is a token of RFC 9110, at offset 17 of "\$request\.header\.a b"/)
    }
    // An expression inside a template is placed in the template.
    try {
      readTemplate('http://x/{$request.body#/a~2}', 'runtime')
      assert.fail('read')
    } catch (err: any) {
      assert.equal(err.text, 'http://x/{$request.body#/a~2}')
      assert.equal(err.offset, 26)
      assert.match(err.message, /a ~ is followed by 0 or 1, at offset 26 of /)
    }
  })

  test('text in a message is cut short', () => {
    const long = '$request.header.' + 'a'.repeat(200) + ' b'
    assert.throws(() => readExpression(long), (err: any) => err.message.length < 160 && err.text === long)
  })

  test('what is no text is a TypeError', () => {
    assert.throws(() => readExpression(1 as any), TypeError)
    assert.throws(() => readTemplate(null as any), TypeError)
    assert.throws(() => readTemplate('/a', 'uri' as any), /kind must be one of path, server, runtime/)
    assert.throws(() => evaluateExpression('$url', null as any), TypeError)
    assert.throws(() => evaluateExpression({} as any, {}), TypeError)
    assert.throws(() => evaluateExpression(readTemplate('/a/{id}'), {}), /a path template holds names/)
    // Text that is no expression is refused as readExpression refuses it.
    assert.throws(() => evaluateExpression('$nope', {}), ExpressionError)
  })

  test('an expression already read is evaluated as it is', () => {
    const e = readExpression('$request.body#/a/0')
    assert.equal(evaluateExpression(e, { request: { body: { a: ['x'] } } }), 'x')
  })

  test('headers are a map, a Map, pairs, or the Headers of the Fetch API', () => {
    const want = (headers: any) => evaluateExpression('$response.header.x-rate', { response: { headers } })
    assert.equal(want({ 'X-Rate': '5' }), '5')
    assert.equal(want(new Map([['X-RATE', '6']])), '6')
    assert.equal(want([['x-rate', '7']]), '7')
    assert.equal(want(new Headers({ 'X-Rate': '8' })), '8')
    assert.equal(want(undefined), undefined)
    assert.equal(want('X-Rate: 9'), undefined)
    // A member named as an Object method is no header.
    assert.equal(evaluateExpression('$request.header.constructor', { request: { headers: {} } }), undefined)
  })

  test('a name is an own member, and nothing inherited', () => {
    const exchange = { request: { query: {}, path: {}, body: {} } }
    for (const e of ['$request.query.toString', '$request.path.constructor', '$request.body#/__proto__', '$request.body#/hasOwnProperty']) {
      assert.equal(evaluateExpression(e, exchange), undefined, e)
    }
    const body = JSON.parse('{"__proto__": 1}')
    assert.equal(evaluateExpression('$request.body#/__proto__', { request: { body } }), 1)
  })
})
