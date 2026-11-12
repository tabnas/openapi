#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/parse-only.cjs: the time and memory of one document, with
// the package alone in the process.
//
// The sweep's own figures include the reference parser's tree, held in
// the same process. This parses and resolves one file with nothing else
// loaded, and prints the time of each and the peak resident memory.
// `parse` and `resolve` are synchronous, so the measured work runs in a
// child process while this one prints a heartbeat every 10 seconds.
//
//   node [--max-old-space-size=<MB>] tools/corpus/parse-only.cjs <file>

const Fs = require('node:fs')
const Path = require('node:path')

const DIST = Path.resolve(process.env.OPENAPI_DIST || Path.join(__dirname, '..', '..', 'ts', 'dist', 'openapi.js'))
const file = process.argv[2]
if (!file) { console.error('usage: node tools/corpus/parse-only.cjs <file>'); process.exit(2) }

if ('measure' === process.env.PARSE_ONLY_ROLE) {
  const O = require(DIST)
  const text = Fs.readFileSync(file, 'utf8')
  let t = Date.now()
  const tree = O.parse(text)
  const parseMs = Date.now() - t
  const afterParse = process.resourceUsage().maxRSS
  t = Date.now()
  let resolve
  try { const r = O.resolve(tree); resolve = { ms: Date.now() - t, sites: r.provenance.length, unresolved: r.unresolved.length, cuts: r.cuts.length } } catch (e) { resolve = { err: e.code ?? String(e.message).slice(0, 200), ms: Date.now() - t } }
  process.send({ file, bytes: Buffer.byteLength(text), parseMs, maxRSSMiBAfterParse: Math.round(afterParse / 1024), resolve, maxRSSMiB: Math.round(process.resourceUsage().maxRSS / 1024) })
} else {
  const { fork } = require('node:child_process')
  const t0 = Date.now()
  const child = fork(__filename, [file], { env: { ...process.env, PARSE_ONLY_ROLE: 'measure' }, execArgv: process.execArgv })
  const hb = setInterval(() => console.log(`parse-only: ${Math.round((Date.now() - t0) / 1000)}s elapsed, still measuring (percentage unknown)`), 10000)
  let result
  child.on('message', (m) => { result = m })
  child.on('exit', (code, signal) => {
    clearInterval(hb)
    if (result) return console.log(JSON.stringify(result))
    console.log(JSON.stringify({ file, failed: { code, signal }, wallMs: Date.now() - t0 }))
    process.exitCode = 1
  })
}
