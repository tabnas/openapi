/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/ledger.cjs: the ledger, from a sweep's records, and its comparison.
//
// The ledger (test/corpus/ledger.tsv) holds one row per way a document
// fails: its source, its path within that source, what happened, and the
// detail. `rowsOf(record)` gives a record's rows; `formatLedger` and
// `parseLedger` write and read the file; `compareLedger` says which rows
// a run added, removed or changed. Every value in a row is a fact about
// the document and the package, never a time or a size of memory, so a
// sweep that changes nothing writes the same file.
//
// What happened, the third column:
//
//   died             the worker ended without finishing: out of memory, a
//                    timeout, a stack overflow or a crash, and the last
//                    phase it finished
//   refused          the package refused text the reference parser accepts;
//                    the detail is the error code
//   refused-invalid  the package and the reference parser both refused it
//   differs          both parsed it and the trees differ; the detail is each
//                    class of difference, sorted, with its number of values
//   unchecked        the package parsed text the reference parser refuses,
//                    so the trees were not compared
//   grammar-refused  JSON text the grammar path refuses (`fast: false`)
//   grammar-differs  JSON text the grammar path reads differently from JSON.parse
//   resolve-threw    `resolve` threw on a description; the detail is the code
//
// test/corpus/accepted.tsv is the judgement beside it, and the only file
// there a person writes: ledger rows that are not this package's defect,
// each with its reason. Its first four columns must equal a ledger row
// exactly; `checkAccepted` says which entries no row of a run matches,
// and the sweep fails on them, since only a person can correct that file.
//
// A module for sweep.cjs and the test in ts/test/corpus-tool.test.ts.

const Fs = require('node:fs')
const { PHASES } = require('./examine.cjs')

const HEADER = ['source', 'path', 'outcome', 'detail']
const ACCEPTED_HEADER = [...HEADER, 'reason']
const OUTCOMES = ['died', 'refused', 'refused-invalid', 'differs', 'unchecked', 'grammar-refused', 'grammar-differs', 'resolve-threw']

// The last record of each document: a run appends, and a retry supersedes.
const lastOf = (records) => [...new Map(records.map((r) => [r.id, r])).values()]

function readRecords(file) {
  if (!Fs.existsSync(file)) return []
  const out = []
  for (const l of Fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch {} // a line cut short by a kill
  }
  return out
}

const codeOf = (err) => err?.code ?? 'uncoded:' + (err?.name ?? 'Error')

// Why a worker ended without finishing, and in which phase.
function deathOf(r) {
  const err = String(r.exit?.stderr ?? '')
  const why = r.crash ? 'crash:' + codeOf(r.crash)
    : r.timeout ? 'timeout'
    : r.exit?.oom || /heap out of memory|Allocation failed|JavaScript heap/i.test(err) ? 'out-of-memory'
    : /Maximum call stack/.test(err) ? 'stack-overflow'
    : r.exit?.signal ? 'signal:' + r.exit.signal
    : 'exit:' + r.exit?.code
  // The phases a document goes through depend on it, so name the last one finished.
  const last = PHASES.filter((p) => p in r).pop()
  return `${why} after ${last ?? 'start'}`
}

const classesDetail = (classes) => Object.keys(classes ?? {}).sort().map((k) => `${k}=${classes[k].n}`).join('; ')

// The reference parser accepted the text: JSON, or YAML with no error
// but duplicate keys.
const referenceAccepts = (r) => 'json' === r.meta?.format || true === r.ref?.yaml?.ok || true === r.ref?.dupKeysOnly

// The ledger rows of one record, as [source, path, outcome, detail].
function rowsOf(r) {
  const rows = []
  const row = (outcome, detail) => rows.push([r.source, r.path, outcome, detail])
  if (!r.done) {
    row('died', deathOf(r))
    return rows
  }
  if (r.parse && !r.parse.ok) row(referenceAccepts(r) ? 'refused' : 'refused-invalid', codeOf(r.parse.err))
  if (r.parse?.ok && !referenceAccepts(r)) row('unchecked', 'the reference parser refuses it: ' + ((r.ref?.yaml?.errors ?? []).map((e) => e.code).join(', ') || 'threw'))
  if (r.compare?.n) row('differs', classesDetail(r.compare.classes))
  if (r.grammar && !r.grammar.ok) row('grammar-refused', codeOf(r.grammar.err))
  if (r.grammar?.n) row('grammar-differs', classesDetail(r.grammar.classes))
  if (r.resolve && false === r.resolve.ok) row('resolve-threw', codeOf(r.resolve.err))
  return rows
}

const clean = (s) => String(s).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
const unclean = (s) => s.replace(/\\(.)/g, (_, c) => ('t' === c ? '\t' : 'n' === c ? '\n' : 'r' === c ? '\r' : c))
const cmpRow = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1 } return 0 }

function ledgerOf(records) {
  return lastOf(records).flatMap(rowsOf).sort(cmpRow)
}

function formatLedger(rows) {
  return [HEADER, ...rows.slice().sort(cmpRow)].map((r) => r.map(clean).join('\t')).join('\n') + '\n'
}

function parseTable(text, header, what) {
  const lines = text.split('\n').filter((l) => '' !== l)
  if (!lines.length || lines[0] !== header.join('\t')) throw new Error(`the first line of ${what} must be the header: ${header.join(' ')}`)
  return lines.slice(1).map((l, i) => {
    const f = l.split('\t').map(unclean)
    if (header.length !== f.length) throw new Error(`${what}, line ${i + 2}, has ${f.length} columns, not ${header.length}`)
    return f
  })
}

const parseLedger = (text) => parseTable(text, HEADER, 'the ledger')

// accepted.tsv: as the ledger, with a reason. Refuses an empty reason and
// an entry given twice.
function parseAccepted(text) {
  const rows = parseTable(text, ACCEPTED_HEADER, 'test/corpus/accepted.tsv')
  const seen = new Set()
  rows.forEach((r, i) => {
    if ('' === r[4].trim()) throw new Error(`test/corpus/accepted.tsv, line ${i + 2}: ${r[0]} ${r[1]} has no reason`)
    const k = r.slice(0, 4).join('\t')
    if (seen.has(k)) throw new Error(`test/corpus/accepted.tsv, line ${i + 2}: ${r[0]} ${r[1]} is given twice`)
    seen.add(k)
  })
  return rows
}

const formatAccepted = (rows) => formatLedger(rows).replace(/^[^\n]*/, ACCEPTED_HEADER.join('\t'))

// Which ledger rows the accepted entries cover, and which entries cover no
// row: those are stranded, because the row is gone or its detail moved.
function checkAccepted(accepted, rows) {
  const have = new Set(rows.map((r) => r.slice(0, 4).join('\t')))
  const stranded = accepted.filter((a) => !have.has(a.slice(0, 4).join('\t')))
  const covered = accepted.length - stranded.length
  const lines = stranded.map((a) => `accepted: ${a[0]} ${a[1]} (${a[2]}, "${a[3]}") matches no ledger row of this run: the row is gone or its detail changed. Delete or correct that entry in test/corpus/accepted.tsv.`)
  return { rows: rows.length, accepted: covered, open: rows.length - covered, stranded, lines }
}

// What moved between the committed rows and this run's, in words.
// A row is keyed by source, path and outcome; a key in both with another
// detail is a changed row.
function compareLedger(before, after) {
  const key = (r) => r.slice(0, 3).join('\t')
  const B = new Map(before.map((r) => [key(r), r]))
  const A = new Map(after.map((r) => [key(r), r]))
  const added = [], removed = [], changed = []
  for (const [k, r] of A) {
    if (!B.has(k)) added.push(r)
    else if (B.get(k)[3] !== r[3]) changed.push({ before: B.get(k), after: r })
  }
  for (const [k, r] of B) if (!A.has(k)) removed.push(r)
  const lines = []
  for (const r of added) lines.push(`ledger: row added: ${r[0]} ${r[1]}: now ${r[2]} (${r[3]}). A regression, unless the change was meant to make this document fail; read it with minimize.cjs.`)
  for (const r of removed) lines.push(`ledger: row removed: ${r[0]} ${r[1]}: was ${r[2]} (${r[3]}), and no longer is. A repair, if the document now reads as the reference parser reads it; then accept it with --write.`)
  for (const { before: b, after: a } of changed) lines.push(`ledger: row changed: ${a[0]} ${a[1]}, ${a[2]}: was "${b[3]}", now "${a[3]}".`)
  return { added, removed, changed, lines, same: 0 === lines.length }
}

module.exports = { HEADER, ACCEPTED_HEADER, OUTCOMES, parseAccepted, formatAccepted, checkAccepted, lastOf, readRecords, rowsOf, deathOf, referenceAccepts, ledgerOf, formatLedger, parseLedger, compareLedger, classesDetail }
