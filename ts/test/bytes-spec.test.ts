/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The fixtures of test/bytes/: what `parse` makes of a text that is
// given as bytes.
//
// A row is the bytes in `hex`, two digits each, then `expected` and
// `opts` as a row of test/spec/ has them: the tree as JSON, or
// `ERROR:<code>`, and the options of `parse`. The bytes are read by
// their byte-order mark, and as UTF-8 without one. See
// ../../test/AGENTS.md.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadSpec } from '@tabnas/support'

import { parse } from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const DIR = join(__dirname, '..', '..', 'test', 'bytes')

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('bytes, from test/bytes', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.tsv'))
    .sort()

  test('the folder holds tables, and nothing else', () => {
    assert.ok(0 < files.length, 'test/bytes has no table')
    assert.deepEqual(readdirSync(DIR).sort(), files)
  })

  for (const file of files) {
    const spec = loadSpec(join(DIR, file))

    test(`${file} has rows`, () => {
      assert.ok(0 < spec.rows.length)
    })

    for (const row of spec.rows) {
      const hex = row.named('hex')
      test(`${file}, row ${row.line}: ${hex.slice(0, 40)}`, () => {
        assert.match(hex, /^(?:[0-9a-f]{2})*$/, 'hex is pairs of digits, in lower case')
        const bytes = Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
        const raw = row.named('opts').trim()
        const opts = '' === raw ? {} : JSON.parse(raw)
        const expected = row.named('expected')
        if (expected.startsWith('ERROR:')) {
          const code = expected.slice('ERROR:'.length)
          assert.throws(
            () => parse(bytes, opts),
            (e: any) => code === e.code,
            `should be refused with ${code}`,
          )
          return
        }
        assert.deepStrictEqual(plain(parse(bytes, opts)), JSON.parse(expected))
      })
    }
  }
})
