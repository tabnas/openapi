#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: the prototype on generated documents.
//
//   EXPR_DIST=<expr build with site.written>/ts/dist/expr.js node generated.cjs [count] [seed]
//
// The documents are the ones tools/apidef-preset/generate.cjs makes from
// a seed: every version, awkward names, references with and without
// sibling members, pointers into members, missing and outside targets,
// identifiers, dialects, a root `$ref`, chains and cycles. Real documents
// rarely hold the shapes the index changes, and these hold them often.
//
// Each is resolved under four sets of options. With the index alone the
// prototype must give today's result, and the exit status is 1 when it
// does not. With landings and typing, each document that moves is counted
// by what the index says of it.

const Path = require('node:path')

const ROOT = Path.join(__dirname, '..', '..', '..', '..')
const { generate } = require(Path.join(ROOT, 'tools', 'apidef-preset', 'generate.cjs'))
const { O, today, proto, diffResults } = require('./compare.cjs')

const COUNT = Number(process.argv[2] ?? 6000)
const SEED = Number(process.argv[3] ?? 1)

const OPTIONS = [
  ['the defaults', undefined],
  ["cycles: 'keep'", { cycles: 'keep' }],
  ["slots: 'all', siblings: 'merge', sharing: 'site'", { slots: 'all', siblings: 'merge', sharing: 'site' }],
  ['the preset', { compat: 'apidef' }],
]

const tally = OPTIONS.map(([name]) => ({ name, compared: 0, index: 0, landings: 0, full: 0, threw: 0, by: {} }))
let unread = 0
let done = 0
let faults = 0
const samples = []
let last = Date.now()
const started = Date.now()

const inc = (o, k) => {
  o[k] = (o[k] ?? 0) + 1
}

for (const item of generate(SEED, COUNT)) {
  done++
  if (15000 <= Date.now() - last) {
    last = Date.now()
    console.log(`generated: ${done} of ${COUNT} (${Math.floor((100 * done) / COUNT)}%), ${faults} faults, ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }
  let raw
  try {
    raw = O.parse(item.text)
  } catch {
    unread++
    continue
  }
  OPTIONS.forEach(([, options], i) => {
    const t = tally[i]
    const T = today(raw, options)
    t.compared++
    if (!T.ok) t.threw++
    const A = diffResults(T, proto(raw, options, 'index'))
    if (A.equal) t.index++
    else {
      faults++
      if (samples.length < 5) samples.push({ name: item.name, options: t.name, text: item.text.slice(0, 400), diff: JSON.stringify(A).slice(0, 500) })
    }
    const B = diffResults(T, proto(raw, options, 'landings'))
    if (B.equal) t.landings++
    const P = proto(raw, options, 'full')
    const C = diffResults(T, P)
    if (C.equal) t.full++
    else if (C.order) inc(t.by, 'the same rows in another order')
    else if (P.ok) {
      // What the index says of a document that moved.
      const ix = P.r.index
      const shapes = []
      if (ix.order.some((r) => 0 < (r.landing?.passes ?? []).length)) shapes.push('a pointer that passes a site')
      if (0 < ix.roots.size) shapes.push('a region typed by a reference')
      inc(t.by, 0 === shapes.length ? 'NEITHER' : shapes.join(' and '))
    } else inc(t.by, 'the prototype threw ' + P.code)
  })
}

console.log(`generated: ${COUNT} documents from seed ${SEED}, ${unread} not read by parse, ${((Date.now() - started) / 1000).toFixed(0)}s\n`)
console.log('| Options | Compared | Index alone equal | With landings equal | With landings and typing equal |')
console.log('|---|---|---|---|---|')
for (const t of tally) console.log(`| ${t.name} | ${t.compared} | ${t.index} | ${t.landings} | ${t.full} |`)
console.log('\nThe documents that move with landings and typing, by what the index says of them:\n')
for (const t of tally) {
  const rows = Object.entries(t.by).sort((a, b) => b[1] - a[1])
  console.log(`- ${t.name}: ${0 === rows.length ? 'none' : rows.map(([k, n]) => `${k}: ${n}`).join('; ')}`)
}
if (0 < faults) {
  console.log(`\n${faults} FAULTS: the index alone moved a result. The first:`)
  for (const s of samples) console.log(JSON.stringify(s))
}
process.exit(0 < faults ? 1 : 0)
