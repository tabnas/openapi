#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/ref-census.cjs: every `$ref` in the corpus that names
// another document, and what that document is.
//
// `resolve` only sees references where a description's version reads one,
// and only in descriptions. This reads every document, fragments
// included, finds every `$ref` value by a regular expression (so the
// counts are approximate: a value holding `{` is cut short, and a
// property named `$ref` is counted too), and reports them by form (see
// `extForm` in examine.cjs) and, for a relative reference, by what the
// file it names holds. A file outside the document's own source is not
// read: the path is the document's, and the document is untrusted.
// Prints a status line every 15 seconds.
//
//   node tools/corpus/ref-census.cjs [--out <dir>]

const Fs = require('node:fs')
const Path = require('node:path')
const E = require('./examine.cjs')
const S = require('./sources.cjs')
const { YAML } = E.load()

const args = process.argv.slice(2)
const oi = args.indexOf('--out')
const OUT = -1 === oi ? Path.join(__dirname, '..', '..', '.corpus', 'run') : Path.resolve(args[oi + 1])
const M = Fs.readFileSync(Path.join(OUT, 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.dupOf)
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n }
const RX = /["']?\$ref["']?\s*:\s*["']?([^"'\s,}]+)/g

const cache = new Map()
function kindOfFile(p) {
  if (cache.has(p)) return cache.get(p)
  let k
  if (!Fs.existsSync(p)) k = 'missing-file'
  else try {
    const t = Fs.readFileSync(p, 'utf8')
    let v
    try { v = JSON.parse(t) } catch { v = YAML.parse(t, { uniqueKeys: false, maxAliasCount: -1 }) }
    if (null == v || 'object' !== typeof v || Array.isArray(v)) k = 'non-map'
    else if ('openapi' in v || 'swagger' in v) k = 'openapi-document'
    else if ('$schema' in v) k = 'json-schema-with-$schema'
    else if (['type', 'properties', 'allOf', 'oneOf', 'anyOf', 'items', 'enum'].some((x) => x in v)) k = 'schema-fragment'
    else if (['get', 'post', 'put', 'delete', 'patch'].some((x) => x in v)) k = 'path-item-fragment'
    else if (['operationId', 'responses', 'requestBody'].some((x) => x in v)) k = 'operation-fragment'
    else if (['content', 'in', 'schema'].some((x) => x in v) || ('description' in v && Object.keys(v).length <= 3)) k = 'response/parameter-fragment'
    else k = 'map-of-named-things/other'
  } catch { k = 'unreadable' }
  cache.set(p, k)
  return k
}

const forms = {}, formDocs = {}, srcDocs = {}, target = {}
let last = Date.now()
M.forEach((r, i) => {
  if (Date.now() - last > 15000) { last = Date.now(); console.error(`ref-census: ${i} of ${M.length} (${((100 * i) / M.length).toFixed(0)}%)`) }
  const text = Fs.readFileSync(r.file, 'utf8')
  const seen = new Set()
  let m
  RX.lastIndex = 0
  while ((m = RX.exec(text))) {
    const ref = m[1]
    if (ref.startsWith('#')) continue
    const f = E.extForm(ref)
    inc(forms, f); seen.add(f)
    if (f.startsWith('relative')) {
      let rel
      try { rel = decodeURIComponent(ref.split('#')[0]) } catch { rel = ref.split('#')[0] }
      const p = Path.resolve(Path.dirname(r.file), rel)
      // The path comes from the document, so nothing outside its own source's checkout is read.
      const home = S.sourceDir({ name: r.source }) + Path.sep
      const kind = p.startsWith(home) ? kindOfFile(p) : 'outside-the-source (not read)'
      inc(target, (p === r.file ? 'SELF ' : '') + kind + (ref.includes('#') ? ' (with fragment)' : ' (whole file)'))
    }
  }
  for (const f of seen) inc(formDocs, f)
  if (seen.size) inc(srcDocs, r.source)
})
console.log(JSON.stringify({ refsByForm: forms, docsByForm: formDocs, docsWithNonLocalRefBySource: srcDocs, relativeTargets: target }, null, 1))
