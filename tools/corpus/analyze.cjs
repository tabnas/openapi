#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/analyze.cjs: a sweep's records, as figures.
//
// `baselineOf(records, environment)` gives the headline figures that
// test/corpus/baseline.json holds: documents by source, version and
// format; what the package parsed, refused and died on; the JSON documents
// the grammar path reads as JSON.parse does; the trees that differ, by
// class and by kind; the YAML features used; what `resolve` reported; and
// the forms of reference into other documents. Nothing in it is a time or
// a size of memory, so a sweep that changes nothing gives the same figures.
// `compareBaseline` says which figures moved. `summary` is the short
// account sweep.cjs prints.
//
// Run as a command, it prints the longer analysis of a results file,
// timings and memory included, by section:
//
//   node tools/corpus/analyze.cjs [.corpus/run/results.jsonl] [all|corpus|parse|compare|resolve|external|features|perf]

const Path = require('node:path')
const { kindOfClass } = require('./examine.cjs')
const L = require('./ledger.cjs')

const VERSIONS = ['2.0', '3.0', '3.1', '3.2']
const isDesc = (r) => VERSIONS.includes(r.meta?.version)
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; return o }
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k] && 'object' === typeof o[k] && !Array.isArray(o[k]) ? sortKeys(o[k]) : o[k]]))

// parsed, refused or died.
const parseOutcome = (r) => (!r.done || !r.parse ? 'died' : r.parse.ok ? 'parsed' : 'refused')

// `ledger`, when given, is the count of ledger rows, and of those the
// entries of test/corpus/accepted.tsv cover and leave open.
function baselineOf(records, environment = {}, ledger = null) {
  const R = L.lastOf(records)
  const b = { environment }
  if (ledger) b.ledger = { rows: ledger.rows, accepted: ledger.accepted, open: ledger.open }

  // Documents.
  const docs = { total: R.length, descriptions: 0, fragments: 0, bySource: {}, byVersion: {} }
  for (const r of R) {
    const s = (docs.bySource[r.source] ??= { documents: 0, descriptions: 0 })
    s.documents++
    if (isDesc(r)) { s.descriptions++; docs.descriptions++ } else docs.fragments++
    const v = (docs.byVersion[r.meta?.version ?? 'unread'] ??= {})
    inc(v, r.meta?.format ?? 'unread')
  }
  b.documents = docs

  // Parse.
  const parse = { all: { parsed: 0, refused: 0, died: 0 }, descriptions: { parsed: 0, refused: 0, died: 0 }, refusedValid: 0, refusedByCode: {}, diedHow: {} }
  for (const r of R) {
    const o = parseOutcome(r)
    parse.all[o]++
    if (isDesc(r)) parse.descriptions[o]++
    if ('refused' === o) { inc(parse.refusedByCode, r.parse.err?.code ?? 'uncoded'); if (L.referenceAccepts(r)) parse.refusedValid++ }
    if ('died' === o) inc(parse.diedHow, L.deathOf(r))
  }
  parse.referenceRefuses = R.filter((r) => r.meta && !L.referenceAccepts(r)).length
  b.parse = parse

  // JSON.
  const json = { documents: 0, grammarEqualsJsonParse: 0, grammarDiffers: 0, grammarRefused: 0, strictAccepts: 0, strictRefusesByCode: {} }
  for (const r of R) {
    if ('json' !== r.meta?.format) continue
    json.documents++
    if (r.grammar?.ok) r.grammar.n ? json.grammarDiffers++ : json.grammarEqualsJsonParse++
    else if (r.grammar) json.grammarRefused++
    if (r.strict?.ok) json.strictAccepts++
    else if (r.strict) inc(json.strictRefusesByCode, r.strict.err?.code ?? 'uncoded')
  }
  b.json = json

  // Trees.
  const trees = { compared: 0, differ: 0, byClass: {}, byKind: {} }
  for (const r of R) {
    if (!r.compare || null == r.compare.n) continue
    trees.compared++
    if (!r.compare.n) continue
    trees.differ++
    const kinds = {}
    for (const [cls, g] of Object.entries(r.compare.classes ?? {})) {
      const c = (trees.byClass[cls] ??= { documents: 0, values: 0 })
      c.documents++; c.values += g.n
      inc(kinds, kindOfClass(cls), g.n)
    }
    const only = 1 === Object.keys(kinds).length
    for (const [k, n] of Object.entries(kinds)) {
      const c = (trees.byKind[k] ??= { documents: 0, values: 0, documentsWithNothingElse: 0 })
      c.documents++; c.values += n
      if (only) c.documentsWithNothingElse++
    }
  }
  b.trees = trees

  // YAML features: documents using each.
  const f = { documents: 0, anchors: 0, aliases: 0, mergeKeys: 0, tags: 0, multiDocument: 0, documentStart: 0, documentEnd: 0, directives: 0, nonStringKeys: 0, complexKeys: 0, flowCollections: 0, blockScalars: 0, tagNames: {}, nonStringKeyTypes: {} }
  for (const r of R) {
    const x = r.meta?.features
    if (!x) continue
    f.documents++
    if (x.anchors) f.anchors++
    if (x.aliases) f.aliases++
    if (x.mergeKeys) f.mergeKeys++
    if (x.tags) f.tags++
    if (x.docs > 1) f.multiDocument++
    if (x.docStart) f.documentStart++
    if (x.docEnd) f.documentEnd++
    if (x.directives) f.directives++
    if (Object.keys(x.nonStringKeys).length) f.nonStringKeys++
    if (x.complexKeys) f.complexKeys++
    if (x.flowCollections) f.flowCollections++
    if (x.blockScalars) f.blockScalars++
    for (const k of Object.keys(x.nonStringKeys)) inc(f.nonStringKeyTypes, k)
    for (const k of Object.keys(x.tagNames)) inc(f.tagNames, k)
  }
  b.yamlFeatures = f

  // resolve.
  const rs = { resolved: 0, threwByCode: {}, skipped: {}, notRun: 0, sites: 0, status: {}, kinds: {}, unresolved: {}, documentsByUnresolved: {}, cuts: 0, documentsWithCuts: 0, dataSlots: 0, documentsWithDataSlots: 0, connections: {}, checks: {} }
  for (const r of R) {
    const x = r.resolve
    if (!x) { if (isDesc(r) && r.parse?.ok) rs.notRun++; continue }
    if (x.skipped) { inc(rs.skipped, x.skipped); continue }
    if (!x.ok) { inc(rs.threwByCode, x.err?.code ?? 'uncoded'); continue }
    rs.resolved++
    rs.sites += x.sites
    for (const [k, v] of Object.entries(x.status)) inc(rs.status, k, v)
    for (const [k, v] of Object.entries(x.kinds)) inc(rs.kinds, k, v)
    for (const [k, v] of Object.entries(x.why)) { inc(rs.unresolved, k, v); inc(rs.documentsByUnresolved, k) }
    rs.cuts += x.cuts
    if (x.cuts) rs.documentsWithCuts++
    const ds = 'number' === typeof x.dataSlots ? x.dataSlots : Array.isArray(x.dataSlots) ? x.dataSlots.length : 0
    rs.dataSlots += ds
    if (ds) rs.documentsWithDataSlots++
    for (const [k, v] of Object.entries(x.connections ?? {})) { const c = (rs.connections[k] ??= { count: 0, notFound: 0 }); c.count += v; c.notFound += x.connMissing?.[k] ?? 0 }
    for (const [w, g] of Object.entries(x.checks ?? {})) for (const [v, n] of Object.entries(g.verdicts)) inc((rs.checks[w] ??= {}), v, n)
  }
  b.resolve = rs

  // References into other documents, by form.
  const ext = { references: 0, documents: 0, forms: {} }
  for (const r of R) {
    const forms = r.resolve?.ext?.forms
    if (!forms || !Object.keys(forms).length) continue
    ext.documents++
    for (const [k, v] of Object.entries(forms)) { const c = (ext.forms[k] ??= { references: 0, documents: 0 }); c.references += v; c.documents++; ext.references += v }
  }
  b.external = ext

  return sortKeys(b)
}

// Leaf figures by dotted path, for the comparison.
function flatten(o, pre = '', out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    const p = pre ? pre + '.' + k : k
    if (v && 'object' === typeof v && !Array.isArray(v)) flatten(v, p, out)
    else out[p] = Array.isArray(v) ? JSON.stringify(v) : v
  }
  return out
}

// Which figures moved, in words. `environment` is reported first, since a
// different dependency or Node is the likeliest reason for the rest.
function compareBaseline(before, after) {
  const B = flatten(before), A = flatten(after)
  const env = [], figures = []
  for (const k of [...new Set([...Object.keys(B), ...Object.keys(A)])].sort()) {
    if (B[k] === A[k]) continue
    const was = k in B ? B[k] : 'absent', now = k in A ? A[k] : 'absent'
    const delta = 'number' === typeof B[k] && 'number' === typeof A[k] ? ` (${A[k] - B[k] > 0 ? '+' : ''}${A[k] - B[k]})` : ''
    const line = `${k}: ${was} -> ${now}${delta}`
    ;(k.startsWith('environment.') ? env : figures).push(line)
  }
  const lines = [
    ...env.map((l) => 'baseline: this run differs from the baseline\'s environment: ' + l),
    ...figures.map((l) => 'baseline: figure moved: ' + l),
  ]
  return { environment: env, figures, lines, same: 0 === lines.length }
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-')

// The short account sweep.cjs prints.
function summary(b) {
  const out = []
  const p = (s) => out.push(s)
  p(`documents: ${b.documents.total}, of which ${b.documents.descriptions} declare a version this package reads`)
  for (const [k, v] of Object.entries(b.documents.bySource)) p(`  ${k}: ${v.documents} (${v.descriptions} descriptions)`)
  p(`parse, every document: ${b.parse.all.parsed} parsed, ${b.parse.all.refused} refused (${b.parse.refusedValid} of them text the reference parser accepts), ${b.parse.all.died} died`)
  p(`parse, descriptions: ${b.parse.descriptions.parsed} parsed, ${b.parse.descriptions.refused} refused, ${b.parse.descriptions.died} died`)
  if (Object.keys(b.parse.refusedByCode).length) p(`  refused, by code: ${Object.entries(b.parse.refusedByCode).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  if (Object.keys(b.parse.diedHow).length) p(`  died: ${Object.entries(b.parse.diedHow).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  p(`JSON: ${b.json.grammarEqualsJsonParse} of ${b.json.documents} equal JSON.parse on the grammar path; ${b.json.grammarDiffers} differ, ${b.json.grammarRefused} refused; strict accepts ${b.json.strictAccepts}`)
  p(`trees: ${b.trees.differ} of ${b.trees.compared} differ from the reference (${pct(b.trees.differ, b.trees.compared)})`)
  for (const [k, v] of Object.entries(b.trees.byKind)) p(`  ${k}: ${v.documents} documents (${v.documentsWithNothingElse} with nothing else), ${v.values} values`)
  const st = b.resolve.status
  p(`resolve: ${b.resolve.resolved} descriptions, ${Object.values(b.resolve.threwByCode).reduce((a, n) => a + n, 0)} threw; ${b.resolve.sites} sites: ${Object.entries(st).map(([k, v]) => `${v} ${k}`).join(', ')}; ${b.resolve.cuts} cuts in ${b.resolve.documentsWithCuts} documents`)
  p(`  left as written: ${Object.entries(b.resolve.unresolved).map(([k, v]) => `${k} ${v} (${b.resolve.documentsByUnresolved[k]} documents)`).join(', ') || 'none'}`)
  p(`  data slots: ${b.resolve.dataSlots} in ${b.resolve.documentsWithDataSlots} documents`)
  p(`references into other documents: ${b.external.references} in ${b.external.documents} documents`)
  if (b.ledger) p(`ledger: ${b.ledger.rows} rows: ${b.ledger.accepted} accepted, ${b.ledger.open} open`)
  return out.join('\n')
}

// --- the longer analysis, as a command
function report(R, section, out = console.log) {
  const b = baselineOf(R)
  const show = (title, v) => out('\n## ' + title + '\n' + ('string' === typeof v ? v : JSON.stringify(v, null, 1)))
  const want = (s) => 'all' === section || s === section
  if (want('corpus')) { show('documents', b.documents); show('summary', summary(b)) }
  if (want('parse')) {
    show('parse', b.parse)
    const bySrc = {}
    for (const r of R) inc((bySrc[r.source] ??= {}), parseOutcome(r))
    show('parse outcome by source', bySrc)
    show('JSON documents', b.json)
    const rows = L.ledgerOf(R)
    show('ledger rows by outcome', rows.reduce((o, r) => inc(o, r[2]), {}))
  }
  if (want('compare')) {
    show('trees', { compared: b.trees.compared, differ: b.trees.differ, byKind: b.trees.byKind })
    const smallest = {}
    for (const r of R) for (const [k, g] of Object.entries(r.compare?.classes ?? {})) if (!smallest[k] || r.size < smallest[k].size) smallest[k] = { size: r.size, source: r.source, path: r.path, sample: g.samples[0] }
    show('classes, with the smallest document showing each', Object.fromEntries(Object.entries(b.trees.byClass).map(([k, v]) => [k, { ...v, smallest: smallest[k] }])))
  }
  if (want('resolve')) show('resolve', b.resolve)
  if (want('external')) {
    show('references into other documents, by form', b.external)
    const hosts = {}, perSource = {}
    for (const r of R) {
      const refs = r.resolve?.ext?.refs
      if (!refs || !Object.keys(refs).length) continue
      inc(perSource, r.source)
      for (const [docPart, n] of Object.entries(refs)) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(docPart)) continue
        try { inc(hosts, new URL(docPart).host, n) } catch { inc(hosts, '(not a URL)', n) }
      }
    }
    show('documents naming another document, by source', perSource)
    show('absolute references, by host', hosts)
  }
  if (want('features')) show('YAML features (documents using each)', b.yamlFeatures)
  if (want('perf')) {
    const rows = R.filter((r) => r.parse?.ok).map((r) => ({ size: r.size, p: r.parse.ms, r: r.resolve?.ms, fmt: r.meta.format, path: r.source + ' ' + r.path, rss: r.parse.rssKiB, rrss: r.resolve?.rssKiB }))
    const buckets = [[0, 1e4], [1e4, 1e5], [1e5, 1e6], [1e6, 4e6], [4e6, 1e9]]
    const q = (a, f) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1) }
    const tbl = []
    for (const fmt of ['yaml', 'json']) for (const [lo, hi] of buckets) {
      const g = rows.filter((x) => x.fmt === fmt && x.size >= lo && x.size < hi)
      if (!g.length) continue
      const rr = g.filter((x) => null != x.r).map((x) => x.r)
      tbl.push(JSON.stringify({ fmt, bytes: `${lo}-${hi}`, n: g.length, parseMs_p50: q(g.map((x) => x.p), 0.5), p90: q(g.map((x) => x.p), 0.9), max: q(g.map((x) => x.p), 1 - 1e-9), resolveMs_p50: q(rr, 0.5), p90r: q(rr, 0.9), maxr: q(rr, 1 - 1e-9) }))
    }
    show('timing by size (a fresh process per document, so small documents are mostly start-up)', tbl.join('\n'))
    show('slowest parses', rows.slice().sort((a, c) => c.p - a.p).slice(0, 12).map((x) => `${x.p.toFixed(0)}ms parse, ${x.r?.toFixed(0)}ms resolve, ${(x.size / 1e6).toFixed(2)}MB ${x.fmt}, maxRSS ${Math.round(x.rss / 1024)}MiB ${x.path}`).join('\n'))
    show('peak memory', rows.slice().sort((a, c) => (c.rrss ?? c.rss) - (a.rrss ?? a.rss)).slice(0, 10).map((x) => `${Math.round((x.rrss ?? x.rss) / 1024)}MiB maxRSS, ${(x.size / 1e6).toFixed(2)}MB ${x.fmt} ${x.path}`).join('\n'))
  }
}

if (require.main === module) {
  const file = process.argv[2] || Path.join(__dirname, '..', '..', '.corpus', 'run', 'results.jsonl')
  const R = L.lastOf(L.readRecords(file))
  if (!R.length) { console.error(`analyze: no records in ${file}`); process.exit(2) }
  report(R, process.argv[3] ?? 'all')
}

module.exports = { baselineOf, compareBaseline, flatten, summary, report, isDesc, parseOutcome }
