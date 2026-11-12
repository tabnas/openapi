/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The corpus tool's own code, on small inline documents.
//
// tools/corpus/ sweeps thousands of real documents and keeps a ledger of
// the ones that fail (test/corpus/ledger.tsv). The sweep needs the network
// and half an hour, so it is not run here. What is run here is the code
// that decides what a failure is: the comparison with the reference
// parser and the classes it gives, the ledger's rows, and the comparison
// that tells a person which rows and figures moved. If that code stopped
// seeing a class, the sweep would report a defect as gone.
//
// The tool is plain JavaScript, loaded with require so that it stays
// outside the compilation.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

type Row = string[]
type Classes = Record<string, { n: number }>
type Rec = Record<string, any>
type Examine = {
  examine(text: string, options?: { ext?: string }): Rec
  kindOfClass(cls: string): string
}
type Accepted = { rows: number; accepted: number; open: number; stranded: Row[]; lines: string[] }
type Ledger = {
  OUTCOMES: string[]
  parseAccepted(text: string): Row[]
  checkAccepted(accepted: Row[], rows: Row[]): Accepted
  rowsOf(record: Rec): Row[]
  formatLedger(rows: Row[]): string
  parseLedger(text: string): Row[]
  compareLedger(before: Row[], after: Row[]): { added: Row[]; removed: Row[]; changed: unknown[]; lines: string[]; same: boolean }
}
type Analyze = {
  compareBaseline(before: object, after: object): { figures: string[]; lines: string[]; same: boolean }
}

// At runtime this file is in ts/dist-test, so the repository root is two up.
const TOOL = join(__dirname, '..', '..', 'tools', 'corpus')
const E: Examine = require(join(TOOL, 'examine.cjs'))
const L: Ledger = require(join(TOOL, 'ledger.cjs'))
const A: Analyze = require(join(TOOL, 'analyze.cjs'))
const CORPUS = join(__dirname, '..', '..', 'test', 'corpus')

// A YAML document examined as the sweep examines a file, with its record's identity.
function sweep(text: string): Rec {
  return { source: 'inline', path: 'doc.yaml', ...E.examine(text, { ext: '.yaml' }) }
}
const classes = (r: Rec): Classes => r.compare?.classes ?? {}
const kinds = (r: Rec): string[] => Object.keys(classes(r)).map(E.kindOfClass).sort()

describe('corpus tool: classifying one document', () => {
  test('a document read as the reference reads it has no difference and no ledger row', () => {
    const r = sweep('openapi: 3.1.0\ninfo:\n  title: t\n  version: "1"\npaths: {}\n')
    assert.strictEqual(r.parse.ok, true)
    assert.strictEqual(r.compare.n, 0)
    assert.strictEqual(r.meta.version, '3.1')
    assert.strictEqual(r.resolve.ok, true)
    assert.deepStrictEqual(L.rowsOf(r), [])
  })

  test('YAML 1.1 words read as booleans are the yaml11-word kind, one value each', () => {
    const r = sweep('a: [on, NO]\n')
    assert.deepStrictEqual(kinds(r), ['yaml11-word'])
    assert.strictEqual(r.compare.n, 2)
    assert.deepStrictEqual(L.rowsOf(r), [['inline', 'doc.yaml', 'differs', 'type:string->boolean:yaml11-bool-word:PLAIN=2']])
  })

  test('an underscore in a number is the underscore-number kind', () => {
    const r = sweep('a: 1_000\n')
    assert.deepStrictEqual(kinds(r), ['underscore-number'])
    assert.deepStrictEqual(L.rowsOf(r), [['inline', 'doc.yaml', 'differs', 'type:string->number:underscore:PLAIN=1']])
  })

  test('a value lost to comment syntax is the comment-syntax kind', () => {
    const r = sweep('a: //x\n')
    assert.deepStrictEqual(kinds(r), ['comment-syntax'])
    assert.deepStrictEqual(L.rowsOf(r), [['inline', 'doc.yaml', 'differs', 'type:string->null:comment-syntax:PLAIN=1']])
  })

  test('valid YAML the package refuses is a refusal with its code', () => {
    const r = sweep('a: /*\n')
    assert.strictEqual(r.ref.yaml.ok, true)
    assert.strictEqual(r.parse.ok, false)
    assert.deepStrictEqual(L.rowsOf(r), [['inline', 'doc.yaml', 'refused', 'unterminated_comment']])
  })
})

describe('corpus tool: the ledger and its comparison', () => {
  const kept: Row = ['apis-guru', 'APIs/a/openapi.yaml', 'differs', 'type:string->boolean:yaml11-bool-word:PLAIN=3']
  const repaired: Row = ['azure', 'specification/b.json', 'refused', 'unterminated_comment']
  const before: Row[] = [kept, repaired, ['github', 'descriptions/c.yaml', 'differs', 'length:BLOCK_SEQ=1']]
  const regressed: Row = ['digitalocean', 'specification/d.yml', 'refused', 'unexpected']
  const after: Row[] = [regressed, kept, ['github', 'descriptions/c.yaml', 'differs', 'length:BLOCK_SEQ=2']]

  test('the ledger is written sorted, with its header, and reads back as written', () => {
    const text = L.formatLedger(after)
    const lines = text.trimEnd().split('\n')
    assert.strictEqual(lines[0], 'source\tpath\toutcome\tdetail')
    assert.deepStrictEqual(lines.slice(1).map((l) => l.split('\t')[0]), ['apis-guru', 'digitalocean', 'github'])
    assert.deepStrictEqual(L.parseLedger(text), L.parseLedger(L.formatLedger(after.slice().reverse())))
    assert.deepStrictEqual(L.parseLedger(text).length, 3)
  })

  test('a row added, a row removed and a row changed are each named', () => {
    const c = L.compareLedger(before, after)
    assert.strictEqual(c.same, false)
    assert.deepStrictEqual(c.added, [regressed])
    assert.deepStrictEqual(c.removed, [repaired])
    assert.strictEqual(c.changed.length, 1)
    const text = c.lines.join('\n')
    assert.match(text, /row added: digitalocean specification\/d\.yml: now refused \(unexpected\)/)
    assert.match(text, /row removed: azure specification\/b\.json: was refused \(unterminated_comment\)/)
    assert.match(text, /row changed: github descriptions\/c\.yaml, differs: was "length:BLOCK_SEQ=1", now "length:BLOCK_SEQ=2"/)
    assert.strictEqual(L.compareLedger(before, before.slice().reverse()).same, true)
  })

  test('a figure that moves is named with its old and new value', () => {
    const was = { parse: { descriptions: { refused: 19, parsed: 5162 } } }
    const now = { parse: { descriptions: { refused: 7, parsed: 5174 } } }
    const c = A.compareBaseline(was, now)
    assert.strictEqual(c.same, false)
    assert.deepStrictEqual(c.figures, ['parse.descriptions.parsed: 5162 -> 5174 (+12)', 'parse.descriptions.refused: 19 -> 7 (-12)'])
    assert.strictEqual(A.compareBaseline(was, JSON.parse(JSON.stringify(was))).same, true)
  })
})

describe('corpus tool: accepted rows', () => {
  const row: Row = ['oai-tests-3.3', 'tests/schema/minimal-objects.yaml', 'refused', 'openapi_root']
  const entry = (r: Row, reason = 'The root is a list.'): string =>
    'source\tpath\toutcome\tdetail\treason\n' + [...r, reason].join('\t') + '\n'

  test('an accepted entry covers its row, and the rest stay open', () => {
    const c = L.checkAccepted(L.parseAccepted(entry(row)), [row, ['github', 'd.yaml', 'differs', 'length:BLOCK_SEQ=1']])
    assert.deepStrictEqual([c.rows, c.accepted, c.open, c.stranded.length], [2, 1, 1, 0])
  })

  test('an entry that matches no row is named, with the file to correct', () => {
    const moved: Row = [row[0], row[1], row[2], 'unexpected']
    const c = L.checkAccepted(L.parseAccepted(entry(row)), [moved])
    assert.deepStrictEqual(c.stranded.map((r) => r.slice(0, 4)), [row])
    assert.match(c.lines.join('\n'), /oai-tests-3\.3 tests\/schema\/minimal-objects\.yaml \(refused, "openapi_root"\) matches no ledger row.*test\/corpus\/accepted\.tsv/)
  })

  test('an entry with no reason, or given twice, is refused', () => {
    assert.throws(() => L.parseAccepted(entry(row, ' ')), /has no reason/)
    assert.throws(() => L.parseAccepted(entry(row) + [...row, 'Again.'].join('\t') + '\n'), /given twice/)
  })
})

describe('corpus tool: the committed ledger, accepted rows and baseline', () => {
  const ledgerText = readFileSync(join(CORPUS, 'ledger.tsv'), 'utf8')
  const ledger = L.parseLedger(ledgerText)
  const acceptedText = readFileSync(join(CORPUS, 'accepted.tsv'), 'utf8')

  test('the ledger reads back byte for byte, sorted, with known outcomes only', () => {
    assert.strictEqual(L.formatLedger(ledger), ledgerText)
    const unknown = ledger.filter((r) => !L.OUTCOMES.includes(r[2]))
    assert.deepStrictEqual(unknown, [])
    assert.ok(ledger.length > 0)
  })

  test('every accepted entry equals a ledger row, once, with a reason', () => {
    const accepted = L.parseAccepted(acceptedText) // refuses an empty reason and a repeat
    assert.ok(accepted.length > 0)
    for (const a of accepted) assert.ok(a[4].trim().length > 0, `${a[0]} ${a[1]} has no reason`)
    const c = L.checkAccepted(accepted, ledger)
    assert.deepStrictEqual(c.lines, [])
    assert.strictEqual(c.accepted, accepted.length)
  })

  test('the baseline parses, and its ledger counts agree with the two files', () => {
    const baseline = JSON.parse(readFileSync(join(CORPUS, 'baseline.json'), 'utf8'))
    const c = L.checkAccepted(L.parseAccepted(acceptedText), ledger)
    assert.deepStrictEqual(baseline.ledger, { accepted: c.accepted, open: c.open, rows: ledger.length })
  })
})
