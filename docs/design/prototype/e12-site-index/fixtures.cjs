#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: the prototype held to the repository's own resolve fixtures.
//
//   EXPR_DIST=<expr build with site.written>/ts/dist/expr.js node fixtures.cjs
//
// Every row of test/resolve/*.tsv is resolved by today's `resolve` and by
// the prototype in each of its modes, under the row's own options, and
// the two results are compared whole: rows, tree, connections. A row that
// the index alone moves is a fault in the prototype, and the exit status
// is 1. A row that landings or typing move is a row whose expected value
// the rebuilt `resolve` will change, and is listed.

const Fs = require('node:fs')
const Path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = Path.join(__dirname, '..', '..', '..', '..')
const { loadSpec } = createRequire(Path.join(ROOT, 'ts', 'package.json'))('@tabnas/support')
const { O, today, proto, diffResults } = require('./compare.cjs')

const DIR = Path.join(ROOT, 'test', 'resolve')
const files = Fs.readdirSync(DIR).filter((f) => f.endsWith('.tsv')).sort()

const J = (v) => {
  const s = JSON.stringify(v)
  return 150 < s.length ? s.slice(0, 147) + '...' : s
}

let faults = 0
const moved = []
console.log('| Fixture | Rows | Index alone | With landings | With landings and typing |')
console.log('|---|---|---|---|---|')
const total = { rows: 0, index: 0, landings: 0, full: 0 }
for (const file of files) {
  const spec = loadSpec(Path.join(DIR, file))
  const n = { rows: 0, index: 0, landings: 0, full: 0 }
  for (const row of spec.rows) {
    const input = row.unescNamed('input')
    const text = row.named('opts').trim()
    const opts = '' === text ? {} : JSON.parse(text)
    let raw
    try {
      raw = O.parse(input)
    } catch {
      continue
    }
    n.rows++
    const T = today(raw, opts)
    const why = {}
    for (const mode of ['index', 'landings', 'full']) {
      const d = diffResults(T, proto(raw, opts, mode))
      if (d.equal) n[mode]++
      else why[mode] = d
    }
    if (null != why.index) {
      faults++
      console.log(`FAULT ${file}:${row.line}: the index alone moves it: ${J(why.index)}`)
    }
    if (null != why.landings || null != why.full) {
      const P = proto(raw, opts, 'full')
      const status = (res) => (res.ok ? res.r.provenance.map((p) => p.at.split('/').pop() + ' ' + p.status).join(', ') : 'throws ' + res.code)
      moved.push({
        at: `${file}:${row.line}`,
        by: null != why.landings ? 'landings' : 'typing',
        opts: text,
        input: input.replace(/\s+/g, ' ').slice(0, 150),
        today: status(T),
        prototype: status(P),
      })
    }
  }
  for (const k of Object.keys(total)) total[k] += n[k]
  console.log(`| \`${file}\` | ${n.rows} | ${n.index} | ${n.landings} | ${n.full} |`)
}
console.log(`| all | ${total.rows} | ${total.index} | ${total.landings} | ${total.full} |`)

console.log(`\n${moved.length} rows move:\n`)
for (const m of moved) {
  console.log(`- ${m.at}, by ${m.by}${'' === m.opts ? '' : ', options ' + m.opts}`)
  console.log(`  - input: ${m.input}`)
  console.log(`  - today: ${m.today}`)
  console.log(`  - prototype: ${m.prototype}`)
}
process.exit(0 < faults ? 1 : 0)
