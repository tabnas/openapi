/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The fixtures of `test/pending/`: parses that only the TypeScript package
// gives yet, such as a new option of `parse`.
//
// `test/spec/` is read by every suite in this repository, so a row there
// must pass in all of them. A row for behaviour only this package has
// would turn the others red, so it lives here until porting starts, in
// the format of `test/spec/` and under the same runner from
// @tabnas/support. Its file then moves to `test/spec/` as it is. See
// ../../test/AGENTS.md, "Where a new fixture goes".
//
// As in the parity runner, every row runs through the `parse` wrapper
// with the options in its `opts` column. The runner fails a folder with
// no fixtures and a fixture with no rows.
//
// A file may have a fourth column, `lossy`, for the report of the
// numbers a tree does not hold exactly, which `parse` fills when it is
// given a `report`. A row with a value there is parsed once more with
// one, and the report is held to the column: one `at row:col text` line
// for each number, with `-` for one the tree does not keep.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadSpec, makeRunner } from '@tabnas/support'

import { parse } from '../dist/openapi'
import type { ParseReport } from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const PENDING = join(__dirname, '..', '..', 'test', 'pending')

makeRunner({
  parse: (input, row) => {
    const opts = row.named('opts')
    return parse(input, '' === opts.trim() ? {} : JSON.parse(opts))
  },
  caseName: (row, input) => `pending, row ${row.line}: ${JSON.stringify(input)}`,
}).dir(PENDING)

describe('pending: the report of the numbers a tree does not hold exactly', () => {
  let rows = 0
  for (const file of readdirSync(PENDING).filter((f) => f.endsWith('.tsv')).sort()) {
    const spec = loadSpec(join(PENDING, file))
    if (!spec.header.includes('lossy')) continue
    for (const row of spec.rows) {
      const want = row.named('lossy').trim()
      if ('' === want) continue
      rows++
      const input = row.unescNamed('input')
      test(`${file}, row ${row.line}: ${JSON.stringify(input).slice(0, 60)}`, () => {
        const opts = row.named('opts').trim()
        const report: ParseReport = {}
        parse(input, { ...('' === opts ? {} : JSON.parse(opts)), report })
        assert.deepEqual(
          report.lossy!.map((l) => `${l.at ?? '-'} ${l.row}:${l.col} ${l.text}`),
          JSON.parse(want),
        )
      })
    }
  }

  test('some row there says a report', () => {
    assert.ok(0 < rows)
  })
})
