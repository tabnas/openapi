#!/usr/bin/env node
'use strict'
// Line-based delta debugging to the smallest text that keeps a failure.
// usage: node minimize.cjs <file> parse-error <code>      (YAML stays valid, tabnas fails with <code>)
//        node minimize.cjs <file> mismatch <class-prefix>  (both parse, a diff class starts with prefix)
//        node minimize.cjs <file> timeout <ms>             (YAML valid, tabnas parse takes over <ms>)
const Fs = require('node:fs')
const W = require('./worker.cjs')
const { YAML, O } = W
const [file, mode, arg, tok] = process.argv.slice(2)
// tok: for parse-error, the error token's source must also match (keeps the same failure, not another one)
const text = Fs.readFileSync(file, 'utf8')
function refOk(t) {
  try {
    const ds = YAML.parseAllDocuments(t, { version: '1.2', schema: 'core', uniqueKeys: false, merge: true })
    if (!Array.isArray(ds) || ds.length !== 1 || ds[0].errors.length) return null
    const v = ds[0].toJS({ maxAliasCount: -1 })
    return null != v && 'object' === typeof v && !Array.isArray(v) ? { v, d: ds[0] } : null
  } catch { return null }
}
function strictRef(t) {
  const d = YAML.parseDocument(t, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false })
  return d.errors.length ? null : { v: d.toJS({ maxAliasCount: -1 }), d }
}
function pred(t) {
  if ('parse-error' === mode) {
    if (!refOk(t)) return false
    if (/^ /.test(t)) return false // an indented root is its own class
    try { O.parse(t); return false } catch (e) { return e.code === arg && (null == tok || e.toJSON?.().token?.src === tok) }
  }
  if ('timeout' === mode) {
    if (!refOk(t)) return false
    const s = Date.now(); try { O.parse(t) } catch {} return Date.now() - s > Number(arg)
  }
  if ('mismatch' === mode) {
    const r = strictRef(t); if (!r || null == r.v || 'object' !== typeof r.v || Array.isArray(r.v)) return false
    let tab; try { tab = O.parse(t) } catch { return false }
    const diffs = W.compare(r.v, tab)
    const g = W.groupDiffs(diffs, r.d, t)
    return Object.keys(g).some((k) => k.startsWith(arg))
  }
}
if (!pred(text)) { console.error('the predicate does not hold on the whole file'); process.exit(2) }
let lines = text.split('\n')
let n = 2
let rounds = 0
while (lines.length >= 2) {
  const chunk = Math.ceil(lines.length / n)
  let reduced = false
  for (let i = 0; i < lines.length; i += chunk) {
    const cand = [...lines.slice(0, i), ...lines.slice(i + chunk)]
    if (pred(cand.join('\n'))) { lines = cand; n = Math.max(n - 1, 2); reduced = true; break }
  }
  if (++rounds % 50 === 0) process.stderr.write(`minimize: ${lines.length} lines left, granularity ${n} (percentage unknown)\n`)
  if (!reduced) { if (n >= lines.length) break; n = Math.min(lines.length, n * 2) }
}
process.stdout.write(lines.join('\n') + '\n')
