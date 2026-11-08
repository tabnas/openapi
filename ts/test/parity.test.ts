/* Copyright (c) 2025-2026 Richard Rodger and other contributors, MIT License */

// Cross-runtime conformance, driven by the shared `test/spec/*.tsv` fixtures
// at the repo root (see ../../test/AGENTS.md).
//
// The fixture loader, the escape codec, the `ERROR:<code>` contract and the
// row loop all come from @tabnas/support, whose Go and Rust halves
// `go/parity_test.go` and `rs/tests/parity_test.rs` use to run the SAME
// files — so the implementations cannot drift without one of them going
// red, and neither can the loaders.
//
// What is left here is only what is specific to this plugin: every row
// runs through the `parse` wrapper with the options in its `opts` column,
// and `raw-fast.tsv` runs twice more, with the fast path forced on and
// off, since its rows hold that both paths give one tree.

import { join } from 'node:path'

import { findSpecDir, makeRunner } from '@tabnas/support'

import { parse } from '../dist/openapi'

// `findSpecDir` walks up from this file — `dist-test/` at runtime — to the
// repo root's `test/spec`, so moving the suite does not mean recounting
// `..` hops.
const SPEC = findSpecDir(__dirname)

// The row's options, with `extra` over them.
function options(row: any, extra: Record<string, unknown> = {}) {
  const opts = row.named('opts')
  return { ...('' === opts.trim() ? {} : JSON.parse(opts)), ...extra }
}

// `dir` auto-discovers every fixture, so adding a .tsv runs it in every
// runtime without touching any runner.
makeRunner({
  parse: (input, row) => parse(input, options(row)),
}).dir(SPEC)

for (const fast of [true, false]) {
  makeRunner({
    parse: (input, row) => parse(input, options(row, { fast })),
    caseName: (row, input) => `fast ${fast}, row ${row.line}: ${JSON.stringify(input)}`,
  }).file(join(SPEC, 'raw-fast.tsv'))
}
