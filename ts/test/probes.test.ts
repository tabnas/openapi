/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The audit of this package against the specification,
// docs/design/prototype/e8-spec-probes.result.md, lists in its section 3
// every probe that showed wrong behaviour. Each has fixture rows that hold
// what the probe gives now: the probes about reading a text in
// test/pending/parse-probes.tsv, and the ones about references in
// test/resolve/probes.tsv, under a `# Probe n.n.` comment.
//
// This test holds the audit's list and the two files to each other, so a
// probe added to the audit needs a row, and a row under a number the audit
// does not have is noticed. The rows themselves run in pending.test.ts and
// resolve-spec.test.ts.

import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const REPO = join(__dirname, '..', '..')

const PARSE = join(REPO, 'test', 'pending', 'parse-probes.tsv')
const RESOLVE = join(REPO, 'test', 'resolve', 'probes.tsv')

// The numbers of the probes, from the headings of the audit's section 3.
function audited(): string[] {
  const text = readFileSync(join(REPO, 'docs', 'design', 'prototype', 'e8-spec-probes.result.md'), 'utf8')
  const from = text.indexOf('\n## (3) ')
  const to = text.indexOf('\n## (4) ')
  assert.ok(0 <= from && from < to, 'the audit has a section 3 before its section 4')
  return [...text.slice(from, to).matchAll(/^- \*\*(\d+\.\d+) /gm)].map((m) => m[1])
}

// A comment line of a fixture: it starts with `#` and has no tab.
const isComment = (line: string) => line.startsWith('#') && !line.includes('\t')

// The probes a fixture file has, each with the rows under its comment, up
// to the next probe's. Rows before the first probe are under no probe.
function rowsByProbe(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let rows: string[] | undefined
  for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
    const m = /^# Probe (\d+\.\d+)\. /.exec(line)
    if (null !== m && isComment(line)) {
      assert.ok(!out.has(m[1]), `${file}: probe ${m[1]} has two comments`)
      rows = []
      out.set(m[1], rows)
    } else if (undefined !== rows && '' !== line.trim() && !isComment(line)) rows.push(line)
  }
  return out
}

test('every probe of the audit has a fixture row, in one of two files', () => {
  const want = audited()
  assert.equal(new Set(want).size, want.length, 'the audit numbers each probe once')
  assert.ok(10 < want.length, 'the audit lists its probes: ' + want.join(' '))
  const parse = rowsByProbe(PARSE)
  const resolve = rowsByProbe(RESOLVE)
  for (const id of want) {
    assert.ok(parse.has(id) !== resolve.has(id), `probe ${id} is in one of the two files, and one only`)
    const rows = (parse.get(id) ?? resolve.get(id))!
    assert.ok(0 < rows.length, `probe ${id} has a row`)
  }
  const have = [...parse.keys(), ...resolve.keys()].sort()
  assert.deepStrictEqual(have, [...want].sort(), 'no row is under a number the audit does not have')
})

test('the first row of probes.tsv has every member a provenance row gained in T3', () => {
  const lines = readFileSync(RESOLVE, 'utf8').split('\n')
  const header = lines[0].split('\t')
  const row = lines.slice(1).find((line) => '' !== line.trim() && !isComment(line))!
  const said = JSON.parse(row.split('\t')[header.indexOf('provenance')]) as string[]
  // `landing` is the place after the arrow, and `-` where there is none.
  assert.ok(said.some((line) => / -> \/\S+/.test(line)), 'a landing')
  assert.ok(said.some((line) => / -> -( |$)/.test(line)), 'a reference that lands nowhere')
  for (const member of ['through', 'uri', 'fragment', 'conflict']) {
    assert.ok(said.some((line) => line.includes(` ${member}=`)), member)
  }
})
