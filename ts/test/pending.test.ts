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

import { join } from 'node:path'

import { makeRunner } from '@tabnas/support'

import { parse } from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const PENDING = join(__dirname, '..', '..', 'test', 'pending')

makeRunner({
  parse: (input, row) => {
    const opts = row.named('opts')
    return parse(input, '' === opts.trim() ? {} : JSON.parse(opts))
  },
  caseName: (row, input) => `pending, row ${row.line}: ${JSON.stringify(input)}`,
}).dir(PENDING)
