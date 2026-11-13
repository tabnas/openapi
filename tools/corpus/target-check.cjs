#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/target-check.cjs: does every resolved reference land where
// its pointer says?
//
// For a seeded sample of the descriptions a sweep resolved (under 3 MB,
// with at least one site), it parses and resolves each again and checks,
// for every resolved site whose `$ref` is a local JSON Pointer, that the
// target `resolve` reports is that pointer, percent-decoded. It prints the
// number checked and the first mismatches, and ends non-zero if any.
//
//   node tools/corpus/target-check.cjs [sample size, default 600] [seed, default 7] [--out <dir>]

const Fs = require('node:fs')
const Path = require('node:path')
const L = require('./ledger.cjs')
const E = require('./examine.cjs')
const { O } = E.load()

const args = process.argv.slice(2)
const oi = args.indexOf('--out')
const OUT = -1 === oi ? Path.join(__dirname, '..', '..', '.corpus', 'run') : Path.resolve(args.splice(oi, 2)[1])
const manifest = new Map(Fs.readFileSync(Path.join(OUT, 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.dupOf).map((r) => [r.id, r]))
const R = L.lastOf(L.readRecords(Path.join(OUT, 'results.jsonl'))).filter((r) => r.resolve?.ok && r.resolve.sites > 0 && r.size < 3e6 && manifest.has(r.id))
let seed = Number(args[1] ?? 7)
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const N = Math.min(Number(args[0] ?? 600), R.length)
const pick = R.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).slice(0, N).map((x) => x[1])
const norm = (frag) => { try { return decodeURIComponent(frag) } catch { return frag } }

let sites = 0, checked = 0, last = Date.now()
const bad = []
pick.forEach((r, i) => {
  if (Date.now() - last > 15000) { last = Date.now(); console.log(`target-check: ${i} of ${N} (${((100 * i) / N).toFixed(0)}%)`) }
  const res = O.resolve(O.parse(Fs.readFileSync(manifest.get(r.id).file, 'utf8')))
  for (const p of res.provenance) {
    sites++
    if ('resolved' !== p.status || 'string' !== typeof p.ref || !p.ref.startsWith('#/')) continue
    checked++
    if (p.target !== norm(p.ref.slice(1))) bad.push({ source: r.source, path: r.path, at: p.at, ref: p.ref, target: p.target })
  }
})
console.log(JSON.stringify({ documents: N, sites, checkedLocalPointerSites: checked, targetMismatches: bad.length, samples: bad.slice(0, 20) }, null, 1))
if (bad.length) process.exitCode = 1
