/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The parser a large text is read by, held to the one a small text is
// read by.
//
// `parse` reads a text past 16 MiB with a parser that keeps its last few
// rules only, which is the plan's Decision 34. A description of that size
// takes a quarter of a minute to read, so no test reads one by both. This
// file holds the two parsers to each other where it costs little:
//
// - on every row of `test/spec/` and `test/pending/`, through the grammar,
//   by a parser built as `parse` builds each of its own. The two must give
//   one outcome: the same tree and the same report, or the same refusal;
// - on the petstore with one member past 16 MiB added, which `parse`
//   itself sends to its bounded parser. A scalar is read in one step, so
//   the text costs little, and the rest of it has a description's shapes.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadSpecDir } from '@tabnas/support'

import { make, parse } from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const ROOT = join(__dirname, '..', '..')

// The two figures are the source's own, read from it, so that this file
// builds the parser `parse` builds and pads a text past the size `parse`
// turns at, whatever they come to be. The size is in ts/src/text.ts,
// with the other limits of one text, since `resolve` holds the documents
// of a description to them too.
function constant(file: string, name: string): number {
  const source = readFileSync(join(ROOT, 'ts', 'src', file), 'utf8')
  const found = new RegExp('^const ' + name + ' = ([0-9][0-9 *]*)$', 'm').exec(source)
  assert.ok(null !== found, `ts/src/${file} declares no ${name} this test can read`)
  return found[1].split('*').reduce((n, part) => n * Number(part), 1)
}
const HISTORY_KEPT = constant('openapi.ts', 'HISTORY_KEPT')
const HISTORY_OVER = constant('text.ts', 'HISTORY_OVER')

type Outcome = { tree: unknown; report: unknown } | { code: unknown; message: string; details: unknown }

function outcome(text: string, options: Record<string, unknown>): Outcome {
  const report = {}
  try {
    return { tree: parse(text, { ...options, report }), report }
  } catch (e: any) {
    return { code: e.code, message: String(e.message), details: e.details }
  }
}

// One parser of each kind for each way `make` builds one.
const parsers: Record<string, { kept: any; bounded: any }> = {}
function pair(options: Record<string, unknown>) {
  const strict = true === options.strict
  const reading = 'spec' === options.reading ? 'spec' : 'base'
  const name = strict ? 'strict' : reading
  if (undefined === parsers[name]) {
    const build = () => (strict ? make({ strict: true }) : make({ reading }))
    const bounded = build()
    bounded.options({ rule: { history: HISTORY_KEPT } })
    parsers[name] = { kept: build(), bounded }
  }
  return parsers[name]
}

describe('the bounded rule history', () => {
  test('the figures this file reads are the ones the source turns on', () => {
    assert.equal(HISTORY_OVER, 16 * 1024 * 1024)
    assert.ok(Number.isInteger(HISTORY_KEPT) && 0 < HISTORY_KEPT, 'HISTORY_KEPT is no count of rules')
  })

  for (const folder of ['spec', 'pending']) {
    const files = loadSpecDir(join(ROOT, 'test', folder))
    test(`every row of test/${folder} reads alike with the history bounded`, () => {
      let rows = 0
      for (const file of files) {
        for (const row of file.rows) {
          const text = row.unesc(row.resolve(0))
          const opts = row.named('opts')
          const options = { ...('' === opts.trim() ? {} : JSON.parse(opts)), fast: false }
          const { kept, bounded } = pair(options)
          assert.deepStrictEqual(
            outcome(text, { ...options, instance: bounded }),
            outcome(text, { ...options, instance: kept }),
            `${row.where()}: the bounded parser and the other part on ${JSON.stringify(text).slice(0, 120)}`,
          )
          rows++
        }
      }
      assert.ok(0 < rows, `test/${folder} has no rows`)
    })
  }

  test('a description past the turn reads alike through parse itself', () => {
    const pad = 'x'.repeat(HISTORY_OVER)
    const yaml = readFileSync(join(ROOT, 'test', 'petstore', 'petstore.yaml'), 'utf8')
    const json = readFileSync(join(ROOT, 'test', 'petstore', 'petstore.json'), 'utf8')
    const expected = JSON.parse(json)
    expected['x-pad'] = pad

    // The member goes first in the YAML and last in the JSON, so that the
    // description is read after the scalar in one and before it in the other.
    const texts: [string, string, Record<string, unknown>][] = [
      ['YAML', 'x-pad: ' + pad + '\n' + yaml, {}],
      ['YAML, by the specification', 'x-pad: ' + pad + '\n' + yaml, { reading: 'spec' }],
      ['JSON, by the grammar', json.replace(/\}\s*$/, ',"x-pad":"' + pad + '"}'), { fast: false }],
      ['strict JSON, by the grammar', json.replace(/\}\s*$/, ',"x-pad":"' + pad + '"}'), { fast: false, strict: true }],
    ]
    for (const [name, text, options] of texts) {
      // With no parser given and no limit, `parse` turns to its bounded one.
      const large = parse(text, options)
      assert.deepEqual(large, expected, `${name}: the bounded parser's tree is not the description`)
      // The same text by a parser that keeps every rule, which needs the
      // limit raised for it.
      const { kept } = pair(options)
      const whole = parse(text, { ...options, instance: kept, maxBytes: Infinity })
      assert.deepStrictEqual(large, whole, `${name}: the two parsers part`)
    }
  })
})
