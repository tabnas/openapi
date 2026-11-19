#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: the figures of a finished run.cjs.
//
//   node report.cjs <results.jsonl> [--corpus <run dir>] [--json <file>]
//
// It prints, for Stripe, GitHub, apidef's definitions, the seeded sample
// of 600 documents that tools/corpus/target-check.cjs draws, and the
// whole corpus: how many documents and sites were compared and how many
// came out equal in each comparison; then every document that differs,
// with the change it is laid at; then what the index found across the
// corpus.

const Fs = require('node:fs')
const Path = require('node:path')

const ROOT = Path.join(__dirname, '..', '..', '..', '..')
const L = require(Path.join(ROOT, 'tools', 'corpus', 'ledger.cjs'))

const args = process.argv.slice(2)
const FILE = args[0]
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return -1 === i ? fallback : args[i + 1]
}
const CORPUS = Path.resolve(opt('corpus', Path.join(ROOT, '.corpus', 'run')))
const JSON_OUT = opt('json')

const rows = Fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => '' !== l.trim()).map((l) => JSON.parse(l))

// The sample target-check.cjs draws: 600 of the descriptions the sweep
// resolved, under 3 MB and with at least one site, by its seed of 7.
function sample600() {
  const manifest = new Map(Fs.readFileSync(Path.join(CORPUS, 'manifest.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((r) => !r.dupOf).map((r) => [r.id, r]))
  const R = L.lastOf(L.readRecords(Path.join(CORPUS, 'results.jsonl')))
    .filter((r) => r.resolve?.ok && r.resolve.sites > 0 && r.size < 3e6 && manifest.has(r.id))
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const N = Math.min(600, R.length)
  return new Set(R.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).slice(0, N).map((x) => x[1].id))
}

const SAMPLE = sample600()
const SETS = [
  ['Stripe', (r) => 'stripe' === r.source || 'stripe-json' === r.source],
  ['GitHub', (r) => 'github' === r.source || 'github-json' === r.source],
  ["apidef's definitions", (r) => 'apidef' === r.set],
  ['the 600-document check set', (r) => SAMPLE.has(r.id)],
  ['the whole corpus', (r) => 'corpus' === r.set],
]

const eq = (d) => null != d && true === d.equal
const sum = (list, f) => list.reduce((n, r) => n + (f(r) ?? 0), 0)
const pad = (s, n) => String(s).padEnd(n)
const num = (n) => n.toLocaleString('en-US')

const out = { sets: [], differ: [], index: {} }

console.log('## Compared\n')
console.log('| Set | Documents | Sites | Index alone | Landings and typing | Under `keep` | Under the preset |')
console.log('|---|---|---|---|---|---|---|')
for (const [name, pick] of SETS) {
  const set = rows.filter(pick)
  const bad = set.filter((r) => r.failed || r.timeout || r.crashed || r.unread)
  const ok = set.filter((r) => !(r.failed || r.timeout || r.crashed || r.unread))
  const withPreset = ok.filter((r) => null != r.preset)
  const row = {
    set: name,
    documents: set.length,
    notCompared: bad.length,
    sites: sum(ok, (r) => r.sites),
    index: ok.filter((r) => eq(r.index)).length,
    full: ok.filter((r) => eq(r.full)).length,
    keep: ok.filter((r) => eq(r.keep)).length,
    preset: withPreset.length ? withPreset.filter((r) => eq(r.preset)).length : null,
    presetOf: withPreset.length,
  }
  out.sets.push(row)
  const of = (n) => `${num(n)} of ${num(ok.length)}`
  console.log(`| ${name} | ${num(set.length)}${bad.length ? ` (${bad.length} not compared)` : ''} | ${num(row.sites)} | ${of(row.index)} | ${of(row.full)} | ${of(row.keep)} | ${null == row.preset ? 'not run' : `${row.preset} of ${row.presetOf}`} |`)
}

// ---- the documents that differ ----

const short = (d) => {
  if (null == d) return 'not run'
  if (d.equal) return 'equal'
  if (d.threw) return 'threw ' + JSON.stringify(d.threw)
  const parts = []
  const rowsOf = (name, x) => {
    if (null == x) return
    parts.push(`${name}: ${x.changed} changed, ${x.onlyB} only in the prototype, ${x.onlyA} only today` + (x.sameRows ? ' (the same rows, in another order)' : ''))
  }
  rowsOf('provenance', d.provenance)
  rowsOf('unresolved', d.unresolved)
  rowsOf('cuts', d.cuts)
  if (d.dataSlots) parts.push(`data slots ${d.dataSlots[0]} and ${d.dataSlots[1]}`)
  if (d.connections) parts.push('connections differ')
  if (d.tree) parts.push(`tree first differs at ${d.tree.path} (${d.tree.what})`)
  return parts.join('; ')
}

console.log('\n## Documents that differ\n')
const differ = rows.filter((r) => !(r.failed || r.timeout || r.crashed || r.unread) &&
  !(eq(r.index) && eq(r.full) && eq(r.keep) && (null == r.preset || eq(r.preset))))
for (const r of differ) {
  // What the difference is laid at: typing, when landings alone give
  // today's result; landings, when they do not.
  const cause = []
  if (!eq(r.index)) cause.push('THE INDEX ALONE')
  if (!eq(r.full)) cause.push(eq(r.landings) ? 'typing' : 'landings')
  if (!eq(r.keep)) {
    if (null != r.keepIndex && !eq(r.keepIndex)) cause.push('THE INDEX ALONE, under keep')
    cause.push(eq(r.keepLandings) ? 'typing, under keep' : 'landings, under keep')
  }
  if (null != r.preset && !eq(r.preset)) cause.push('THE PRESET')
  const s = r.stats ?? {}
  const rec = {
    source: r.source,
    path: r.path,
    sites: r.sites,
    cause: [...new Set(cause)],
    full: short(r.full),
    landings: short(r.landings),
    keep: short(r.keep),
    rounds: s.rounds,
    roots: s.roots,
    under: s.landings?.under,
    through: s.landings?.through,
  }
  out.differ.push(rec)
  console.log(`- ${r.source} ${r.path} (${num(r.sites ?? 0)} sites): ${rec.cause.join(', ')}`)
  console.log(`  - landings and typing: ${rec.full}`)
  if (null != r.landings) console.log(`  - landings alone: ${rec.landings}`)
  console.log(`  - under keep: ${rec.keep}`)
  console.log(`  - index: ${s.rounds} rounds, ${s.roots} regions typed by a reference, ${s.landings?.under} landings inside a site, ${s.landings?.through} through a site`)
}
if (0 === differ.length) console.log('None.')

const failed = rows.filter((r) => r.failed || r.timeout || r.crashed)
if (0 < failed.length) {
  console.log('\n## Not compared\n')
  for (const r of failed) console.log(`- ${r.source} ${r.path}: ${r.failed ?? r.crashed ?? 'ran past ' + r.timeout + ' s'}`)
}

// ---- what the index found ----

const corpus = rows.filter((r) => 'corpus' === r.set && null != r.stats)
const tot = {
  documents: corpus.length,
  maps: sum(corpus, (r) => r.stats.maps),
  sites: sum(corpus, (r) => r.stats.sites),
  rounds: {},
  roots: sum(corpus, (r) => r.stats.roots),
  docsWithRoots: corpus.filter((r) => 0 < r.stats.roots).length,
  sitesByRound: {},
  landings: {},
  docsWith: {},
  why: {},
  conflicts: sum(corpus, (r) => r.stats.conflicts),
  docsWithConflicts: corpus.filter((r) => 0 < r.stats.conflicts).length,
  conflictKinds: {},
  conflictDocs: {},
}
const inc = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n
}
for (const r of corpus) {
  const s = r.stats
  inc(tot.rounds, s.rounds)
  for (const [k, n] of Object.entries(s.byRound)) inc(tot.sitesByRound, k, n)
  for (const [k, n] of Object.entries(s.landings)) {
    inc(tot.landings, k, n)
    if (0 < n) inc(tot.docsWith, k)
  }
  for (const [k, n] of Object.entries(s.why)) inc(tot.why, k, n)
  for (const [k, n] of Object.entries(s.conflictKinds)) {
    inc(tot.conflictKinds, k, n)
    inc(tot.conflictDocs, k)
  }
}
out.index = tot

console.log('\n## What the index found in the corpus\n')
console.log(`- ${num(tot.documents)} documents, ${num(tot.maps)} maps, ${num(tot.sites)} sites.`)
console.log(`- Rounds: ${Object.entries(tot.rounds).sort((a, b) => a[0] - b[0]).map(([k, n]) => `${num(n)} documents end after round ${k}`).join(', ')}.`)
console.log(`- Sites by the round they were found in: ${Object.entries(tot.sitesByRound).sort((a, b) => a[0] - b[0]).map(([k, n]) => `round ${k}: ${num(n)}`).join(', ')}.`)
console.log(`- Regions typed by a reference: ${num(tot.roots)}, in ${num(tot.docsWithRoots)} documents.`)
console.log('- Landings:')
for (const k of ['found', 'missing', 'loop', 'depth', 'passes', 'through', 'under', 'passesAndMissing', 'typedByReference', 'inData']) {
  console.log(`  - ${pad(k, 18)} ${num(tot.landings[k] ?? 0)} sites in ${num(tot.docsWith[k] ?? 0)} documents`)
}
console.log(`- Sites that name nothing in the document: ${Object.entries(tot.why).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${num(n)}`).join(', ')}.`)
console.log(`- Conflicts, a landing whose type is not the one its reference expects: ${num(tot.conflicts)} in ${num(tot.docsWithConflicts)} documents.`)
for (const [k, n] of Object.entries(tot.conflictKinds).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  - ${pad(k, 44)} ${num(n)} in ${num(tot.conflictDocs[k])} documents`)
}

const through = rows.filter((r) => 0 < (r.stats?.landings?.through ?? 0))
console.log(`\n## References that need the lenient pointer rule\n`)
console.log(`${num(sum(through, (r) => r.stats.landings.through))} references in ${through.length} documents pass through a site that lacks the step as written.`)
for (const r of through.slice(0, 40)) {
  console.log(`- ${r.source} ${r.path}: ${r.stats.landings.through}`)
  for (const t of r.stats.samples.through.slice(0, 2)) console.log(`  - ${t.at} names ${t.ref}, lands on ${t.landing} through ${t.through.join(', ')}`)
}
const under = rows.filter((r) => 0 < (r.stats?.landings?.under ?? 0))
console.log(`\n## References that land inside a site, as written\n`)
console.log(`${num(sum(under, (r) => r.stats.landings.under))} references in ${under.length} documents.`)
for (const r of under.slice(0, 40)) {
  console.log(`- ${r.source} ${r.path}: ${r.stats.landings.under}`)
  for (const t of r.stats.samples.under.slice(0, 2)) console.log(`  - ${t.at} names ${t.ref}, which is inside the site ${t.under}`)
}

const ms = (k) => sum(rows, (r) => r.ms?.[k]) / 1000
console.log('\n## Time\n')
console.log(`Over every document: parse ${sum(rows, (r) => r.parseMs / 1000).toFixed(1)} s; today's resolve ${ms('today').toFixed(1)} s; ` +
  `the prototype with the index alone ${ms('index').toFixed(1)} s, with landings and typing ${ms('full').toFixed(1)} s; ` +
  `under keep, today ${ms('keepToday').toFixed(1)} s and the prototype ${ms('keepFull').toFixed(1)} s.`)

if (null != JSON_OUT) Fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1) + '\n')
