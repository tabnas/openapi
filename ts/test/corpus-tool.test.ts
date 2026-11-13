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

import { after, describe, test } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

type Row = string[]
type Classes = Record<string, { n: number }>
type Rec = Record<string, any>
type Walk = { ok: boolean; err?: string; node?: unknown }
type Examine = {
  examine(text: string, options?: { ext?: string }): Rec
  kindOfClass(cls: string): string
  walkPtr(root: unknown, fragment: string, options?: { follow?: boolean }): Walk
}
type Accepted = { rows: number; accepted: number; open: number; stranded: Row[]; lines: string[] }
type Ledger = {
  OUTCOMES: string[]
  parseAccepted(text: string): Row[]
  checkAccepted(accepted: Row[], rows: Row[]): Accepted
  rowsOf(record: Rec): Row[]
  readRecords(file: string): Rec[]
  closeCutLine(file: string): boolean
  formatLedger(rows: Row[]): string
  parseLedger(text: string): Row[]
  compareLedger(before: Row[], after: Row[]): { added: Row[]; removed: Row[]; changed: unknown[]; lines: string[]; same: boolean }
}
type Analyze = {
  compareBaseline(before: object, after: object): { figures: string[]; lines: string[]; same: boolean }
}
type Sources = { codeHash(dir: string): string }
type Sweep = {
  buildOf(): Record<string, string>
  runDiffers(was: object, now: object): string[]
}

// At runtime this file is in ts/dist-test, so the repository root is two up.
const TOOL = join(__dirname, '..', '..', 'tools', 'corpus')
const E: Examine = require(join(TOOL, 'examine.cjs'))
const L: Ledger = require(join(TOOL, 'ledger.cjs'))
const A: Analyze = require(join(TOOL, 'analyze.cjs'))
const S: Sources = require(join(TOOL, 'sources.cjs'))
const W: Sweep = require(join(TOOL, 'sweep.cjs'))
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

  test('a repeated member name alone leaves no row, and hides no other difference', () => {
    const alone = sweep('a: x\nb: 1\nb: 2\n')
    assert.strictEqual(alone.ref.dupKeysOnly, true)
    assert.strictEqual(alone.compare.n, 0)
    assert.deepStrictEqual(L.rowsOf(alone), [])
    const both = sweep('a: on\nb: 1\nb: 2\n')
    assert.strictEqual(both.compare.n, 1)
    assert.deepStrictEqual(L.rowsOf(both), [['inline', 'doc.yaml', 'differs', 'type:string->boolean:yaml11-bool-word:PLAIN=1']])
  })

  test('a reference the check cannot follow to an end is a verdict, and the document finishes', () => {
    // B names a member that A's example lacks; the example holds a `$ref` of
    // its own, which the check follows, and which leads back to itself.
    const missing = '#/components/schemas/A/example/missing'
    const r = sweep(JSON.stringify({
      openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {},
      components: { schemas: { A: { type: 'object', example: { $ref: missing } }, B: { $ref: missing } } },
    }))
    assert.ok(r.done, 'the document did not finish')
    assert.deepStrictEqual(r.resolve.why, { 'not-found': 1 })
    assert.deepStrictEqual(r.resolve.checks['not-found'].verdicts, { 'absent:absent': 1 })
    assert.deepStrictEqual(L.rowsOf(r), [])
  })
})

describe('corpus tool: walking a pointer', () => {
  const follow = { follow: true }

  test('a plain pointer lands, or says where it stops', () => {
    assert.deepStrictEqual(E.walkPtr({ a: { 'b/c': [1, { d: 2 }] } }, '/a/b~1c/1/d'), { ok: true, node: 2 })
    assert.strictEqual(E.walkPtr({ a: 1 }, '/a/b').err, 'scalar')
    assert.strictEqual(E.walkPtr({ a: {} }, '/a/b').err, 'absent')
    assert.strictEqual(E.walkPtr({ a: [1] }, '/a/1').err, 'index')
  })

  test('with follow, a map that lacks the member is walked through its reference', () => {
    const tree = { a: { $ref: '#/b' }, b: { x: 1 } }
    assert.strictEqual(E.walkPtr(tree, '/a/x').ok, false)
    assert.deepStrictEqual(E.walkPtr(tree, '/a/x', follow), { ok: true, node: 1 })
  })

  test('references that lead back to themselves end the walk', () => {
    assert.strictEqual(E.walkPtr({ a: { $ref: '#/a/x' } }, '/a/x', follow).ok, false)
    assert.strictEqual(E.walkPtr({ a: { $ref: '#/a' } }, '/a/x', follow).err, 'cycle')
    assert.strictEqual(E.walkPtr({ a: { $ref: '#/b' }, b: { $ref: '#/a' } }, '/a/x', follow).err, 'cycle')
  })

  test('a pointer through a recursive schema, and a long chain of references, are not cycles', () => {
    const node = { Node: { properties: { next: { $ref: '#/Node' }, v: { type: 'string' } } } }
    assert.deepStrictEqual(E.walkPtr(node, '/Node/properties/next/properties/next/properties/v/type', follow), { ok: true, node: 'string' })
    const chain: Record<string, unknown> = { k300: { x: 1 } }
    for (let i = 0; i < 300; i++) chain['k' + i] = { $ref: '#/k' + (i + 1) }
    assert.deepStrictEqual(E.walkPtr(chain, '/k0/x', follow), { ok: true, node: 1 })
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

describe('corpus tool: what a run folder is held to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-tool-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  test('the hash of a build moves with a file\'s content and its name, and with nothing else', () => {
    const build = join(dir, 'build')
    mkdirSync(join(build, 'sub'), { recursive: true })
    mkdirSync(join(build, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(build, 'a.js'), 'exports.a = 1\n')
    writeFileSync(join(build, 'sub', 'b.js'), 'exports.b = 1\n')
    const first = S.codeHash(build)
    assert.match(first, /^[0-9a-f]{40}$/)
    assert.strictEqual(S.codeHash(build), first)

    writeFileSync(join(build, 'a.d.ts'), 'export declare const a: number\n')
    writeFileSync(join(build, 'node_modules', 'dep', 'index.js'), 'exports.dep = 1\n')
    assert.strictEqual(S.codeHash(build), first, 'a declaration file or a dependency moved the hash')

    writeFileSync(join(build, 'sub', 'b.js'), 'exports.b = 2\n')
    const edited = S.codeHash(build)
    assert.notStrictEqual(edited, first, 'an edited file did not move the hash')

    renameSync(join(build, 'sub', 'b.js'), join(build, 'sub', 'c.js'))
    assert.notStrictEqual(S.codeHash(build), edited, 'a renamed file did not move the hash')
  })

  test('the code a run is held to is this package\'s build, each dependency it names and the measuring code', () => {
    const build = W.buildOf()
    assert.deepStrictEqual(Object.keys(build).sort(), [
      '@tabnas/expr', '@tabnas/json', '@tabnas/jsonic', '@tabnas/openapi', '@tabnas/parser', '@tabnas/yaml', 'tools/corpus',
    ])
    for (const [name, hash] of Object.entries(build)) assert.match(hash, /^[0-9a-f]{40}$/, name)
  })

  test('a run of the same build is resumed, and a run of other code is named', () => {
    const env = { node: 24, package: { name: '@tabnas/openapi', version: '0.1.0' } }
    const build = { '@tabnas/openapi': 'aaaa', '@tabnas/yaml': 'bbbb' }
    assert.deepStrictEqual(W.runDiffers({ ...env, build }, { ...env, build: { ...build } }), [])
    assert.deepStrictEqual(
      W.runDiffers({ ...env, build }, { ...env, build: { ...build, '@tabnas/openapi': 'cccc' } }),
      ['build.@tabnas/openapi: aaaa -> cccc'],
    )
    // A run made before builds were recorded is not this build's either.
    assert.deepStrictEqual(W.runDiffers(env, { ...env, build }), [
      'build.@tabnas/openapi: absent -> aaaa', 'build.@tabnas/yaml: absent -> bbbb',
    ])
    assert.deepStrictEqual(W.runDiffers({ ...env, build }, { ...env, node: 22, build }), ['node: 24 -> 22 (-2)'])
  })

  test('a results line cut short is ended, so that the next record is read', () => {
    const file = join(dir, 'results.jsonl')
    assert.strictEqual(L.closeCutLine(file), false, 'no file')
    writeFileSync(file, '')
    assert.strictEqual(L.closeCutLine(file), false, 'an empty file')

    writeFileSync(file, '{"id":"a","done":{}}\n{"id":"b","par')
    // Appended to as it is, the next record joins the cut line and both are lost.
    appendFileSync(file, '{"id":"c","done":{}}\n')
    assert.deepStrictEqual(L.readRecords(file).map((r) => r.id), ['a'])

    writeFileSync(file, '{"id":"a","done":{}}\n{"id":"b","par')
    assert.strictEqual(L.closeCutLine(file), true)
    appendFileSync(file, '{"id":"c","done":{}}\n')
    assert.deepStrictEqual(L.readRecords(file).map((r) => r.id), ['a', 'c'])
    assert.strictEqual(L.closeCutLine(file), false, 'a file that ends its last line')
    assert.deepStrictEqual(L.readRecords(file).map((r) => r.id), ['a', 'c'])
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
