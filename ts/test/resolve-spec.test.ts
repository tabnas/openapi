/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The resolver against test/resolve/*.tsv. Each row parses its input,
// resolves it with the row's options, and holds the resolved tree, the
// references left as written (`at why`) and the cut edges to the row; an
// `ERROR:<code>` row holds the code `resolve` raises. These fixtures live
// outside test/spec/ because the parity runners there read a parse, and
// because the Go and Rust ports do not carry the resolver yet.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadSpec } from '@tabnas/support'

import { parse, resolve } from '../dist/openapi'

const DIR = join(__dirname, '..', '..', 'test', 'resolve')

const C = (x: any) => JSON.parse(JSON.stringify(x))

const files = readdirSync(DIR).filter((f) => f.endsWith('.tsv')).sort()

test('there are resolve fixtures', () => {
  assert.ok(0 < files.length, 'no fixtures in ' + DIR)
})

for (const file of files) {
  const spec = loadSpec(join(DIR, file))
  describe('resolve: ' + file, () => {
    test('has rows', () => {
      assert.ok(0 < spec.rows.length, file + ' has no rows')
    })
    for (const row of spec.rows) {
      const input = row.unescNamed('input')
      test(`row ${row.line}: ${JSON.stringify(input).slice(0, 60)}`, () => {
        const raw = row.named('opts').trim()
        const opts = '' === raw ? {} : JSON.parse(raw)
        const expected = row.named('expected')
        if (expected.startsWith('ERROR:')) {
          const code = expected.slice('ERROR:'.length)
          assert.throws(
            () => resolve(parse(input), opts),
            (err: any) => code === err.code,
            `${file}:${row.line} should raise ${code}`,
          )
          return
        }
        const out = resolve(parse(input), opts)
        assert.deepStrictEqual(C(out.tree), JSON.parse(expected), `${file}:${row.line} tree`)
        assert.deepStrictEqual(
          out.unresolved.map((u) => u.at + ' ' + u.why),
          JSON.parse(row.named('unresolved') || '[]'),
          `${file}:${row.line} unresolved`,
        )
        assert.deepStrictEqual(
          out.cuts.map((c) => c.at),
          JSON.parse(row.named('cuts') || '[]'),
          `${file}:${row.line} cuts`,
        )
      })
    }
  })
}
