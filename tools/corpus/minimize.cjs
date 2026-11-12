#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/minimize.cjs: cut a failing document down to the smallest
// text that still fails the same way.
//
// Line-based delta debugging. It removes chunks of lines while the
// predicate still holds, and prints what is left. The predicate:
//
//   parse-error <code> [token]  the reference parser accepts the text as one
//                               YAML map, and the package refuses it with
//                               <code> (and, if given, at a token with that source)
//   mismatch <class-prefix>     both read it, and a class of difference
//                               starts with <class-prefix> (see examine.cjs)
//   timeout <ms>                the reference accepts it, and the package
//                               takes more than <ms> to parse it
//
//   node tools/corpus/minimize.cjs <file> <predicate> <argument> [token] > small.yaml
//
// It prints a status line every 50 rounds, with the lines left.

const Fs = require('node:fs')
const E = require('./examine.cjs')
const { YAML, O } = E.load()

const [file, mode, arg, tok] = process.argv.slice(2)
if (!file || !['parse-error', 'mismatch', 'timeout'].includes(mode)) {
  console.error('usage: node tools/corpus/minimize.cjs <file> parse-error|mismatch|timeout <argument> [token]')
  process.exit(2)
}
const text = Fs.readFileSync(file, 'utf8')

function refOk(t) {
  try {
    const ds = YAML.parseAllDocuments(t, { version: '1.2', schema: 'core', uniqueKeys: false, merge: true })
    if (!Array.isArray(ds) || 1 !== ds.length || ds[0].errors.length) return null
    const v = ds[0].toJS({ maxAliasCount: -1 })
    return null != v && 'object' === typeof v && !Array.isArray(v) ? { v, d: ds[0] } : null
  } catch { return null }
}
function strictRef(t) {
  const d = YAML.parseDocument(t, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false })
  return d.errors.length ? null : { v: d.toJS({ maxAliasCount: -1 }), d }
}
function holds(t) {
  if ('parse-error' === mode) {
    if (!refOk(t)) return false
    if (/^ /.test(t)) return false // an indented root is its own class
    try { O.parse(t); return false } catch (e) { return e.code === arg && (null == tok || e.toJSON?.().token?.src === tok) }
  }
  if ('timeout' === mode) {
    if (!refOk(t)) return false
    const s = Date.now()
    try { O.parse(t) } catch {}
    return Date.now() - s > Number(arg)
  }
  const r = strictRef(t)
  if (!r || null == r.v || 'object' !== typeof r.v || Array.isArray(r.v)) return false
  let tab
  try { tab = O.parse(t) } catch { return false }
  return Object.keys(E.groupDiffs(E.compare(r.v, tab), r.d, t)).some((k) => k.startsWith(arg))
}

if (!holds(text)) { console.error('minimize: the predicate does not hold on the whole file'); process.exit(2) }
let lines = text.split('\n')
let n = 2
let rounds = 0
while (lines.length >= 2) {
  const chunk = Math.ceil(lines.length / n)
  let reduced = false
  for (let i = 0; i < lines.length; i += chunk) {
    const cand = [...lines.slice(0, i), ...lines.slice(i + chunk)]
    if (holds(cand.join('\n'))) { lines = cand; n = Math.max(n - 1, 2); reduced = true; break }
  }
  if (0 === ++rounds % 50) process.stderr.write(`minimize: ${lines.length} lines left, granularity ${n} (percentage unknown)\n`)
  if (!reduced) { if (n >= lines.length) break; n = Math.min(lines.length, n * 2) }
}
process.stdout.write(lines.join('\n') + '\n')
