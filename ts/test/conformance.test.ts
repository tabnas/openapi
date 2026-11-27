/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The conformance statement, docs/conformance.md. Its prose is written
// by hand and its figures by tools/corpus/statement.cjs, from the
// records that the corpus tools keep in test/corpus/. This holds the two
// together: a sweep that is accepted with `--write` moves a record, and
// the page has to move with it.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const ROOT = join(__dirname, '..', '..')

const S = require(join(ROOT, 'tools', 'corpus', 'statement.cjs'))

describe('the conformance statement', () => {
  const page = readFileSync(S.PAGE, 'utf8')
  const block = page.slice(page.indexOf(S.OPEN) + S.OPEN.length, page.indexOf(S.CLOSE))

  test('its figures are the recorded ones', () => {
    assert.equal(
      page,
      S.withFigures(page, S.figures()),
      'docs/conformance.md is stale: run node tools/corpus/statement.cjs --write',
    )
  })

  test('every source of the corpus is in it, by its repository and its commit', () => {
    const sources = JSON.parse(readFileSync(join(ROOT, 'tools', 'corpus', 'sources.json'), 'utf8')).sources
    const named: { name: string; repository: string; commit: string }[] = Array.isArray(sources) ? sources : Object.values(sources)
    assert.ok(0 < named.length)
    for (const s of named) {
      assert.ok(block.includes('`' + s.repository + '`'), `no row for ${s.name}`)
      assert.ok(block.includes('`' + s.commit.slice(0, 12) + '`'), `no commit for ${s.name}`)
    }
  })

  test('no row of the ledger it is measured by is open', () => {
    // The claim of the page: under the specification's reading, each row
    // has a reason. A row without one is written as open, in capitals.
    assert.ok(!block.includes('OPEN'), 'a ledger row has no reason in test/corpus/accepted.tsv')
    const baseline = JSON.parse(readFileSync(join(ROOT, 'test', 'corpus', 'baseline-spec.json'), 'utf8'))
    assert.equal(baseline.ledger.open, 0)
    assert.equal(baseline.resolve.heldAsWritten, 0)
    assert.deepEqual(baseline.resolve.threwByCode, {})
  })

  test('the figures block is replaced, and nothing else of the page', () => {
    const before = 'a\n' + S.OPEN + '\nold\n' + S.CLOSE + '\nz\n'
    assert.equal(S.withFigures(before, 'new'), 'a\n' + S.OPEN + '\n\nnew\n\n' + S.CLOSE + '\nz\n')
    assert.throws(() => S.withFigures('no block here', 'new'), /no figures block/)
  })
})
