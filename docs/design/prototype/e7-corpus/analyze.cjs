#!/usr/bin/env node
'use strict'
// Aggregate a results file into the numbers the report needs.
// usage: node analyze.cjs <results.jsonl> [section]
const Fs = require('node:fs')
const file = process.argv[2]
const section = process.argv[3] ?? 'all'
const R = Fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; return o }
const out = (title, v) => console.log('\n## ' + title + '\n' + (typeof v === 'string' ? v : JSON.stringify(v, null, 1)))

// a document is a "description" if it names a version; a "fragment" otherwise
const isDesc = (r) => ['2.0', '3.0', '3.1', '3.2'].includes(r.meta?.version)
const parseOutcome = (r) => {
  if (r.exit && !r.parse) return r.timeout ? 'timeout:' + r.timeout : 'crash'
  if (!r.parse) return 'no-parse-record'
  if (r.parse.ok) return 'ok'
  const refValid = r.meta?.format === 'json' ? true : r.ref?.yaml?.ok === true || (r.ref?.dupKeysOnly && 'dup')
  return refValid ? 'rejects-valid' : 'rejects-invalid'
}

if ('all' === section || 'corpus' === section) {
  const by = {}
  for (const r of R) {
    const k = r.source
    by[k] ??= { docs: 0, bytes: 0, desc: 0, frag: 0, versions: {}, formats: {} }
    by[k].docs++; by[k].bytes += r.size
    isDesc(r) ? by[k].desc++ : by[k].frag++
    inc(by[k].versions, r.meta?.version ?? 'none'); inc(by[k].formats, r.meta?.format ?? '?')
  }
  out('corpus by source', by)
  const v = {}
  for (const r of R) { inc(v, (r.meta?.version ?? '?') + '/' + (r.meta?.format ?? '?')) }
  out('version/format', v)
  out('total', { docs: R.length, bytes: R.reduce((a, r) => a + r.size, 0), descriptions: R.filter(isDesc).length })
}
if ('all' === section || 'parse' === section) {
  const o = {}, oDesc = {}, codes = {}
  for (const r of R) { const p = parseOutcome(r); inc(o, p); if (isDesc(r)) inc(oDesc, p); if (!r.parse?.ok && r.parse) inc(codes, p + ' ' + r.parse.err?.code + ' ' + (r.parse.err?.code ? '' : r.parse.err?.msg)) }
  out('parse outcome (all docs)', o)
  out('parse outcome (descriptions)', oDesc)
  out('failure codes', codes)
  const bySrc = {}
  for (const r of R) { const p = parseOutcome(r); bySrc[r.source] ??= {}; inc(bySrc[r.source], p) }
  out('parse outcome by source', bySrc)
  const refInvalid = {}
  for (const r of R) if (r.meta?.format === 'yaml' && r.ref?.yaml && !r.ref.yaml.ok) inc(refInvalid, (r.ref.yamlDocs > 1 ? 'multi-doc ' : '') + (r.ref.yaml.errors?.map((e) => e.code).join(',') || 'threw') + ' tabnas:' + (r.parse?.ok ? 'ok' : r.parse?.err?.code))
  out('yaml reference rejects (by yaml error codes, and what tabnas did)', refInvalid)
  const json = {}
  for (const r of R) if (r.meta?.format === 'json') { inc(json, 'grammar:' + (r.grammar?.ok ? (r.grammar.n ? 'mismatch' : 'ok') : r.grammar ? 'err ' + r.grammar.err?.code : r.timeout ? 'timeout ' + r.timeout : 'none')); inc(json, 'strict:' + (r.strict?.ok ? 'ok' : r.strict ? 'err ' + r.strict.err?.code : r.timeout ? 'timeout ' + r.timeout : 'none')) }
  out('JSON docs: grammar path (fast:false) and strict', json)
  const ex = {}
  for (const r of R) if (r.exit) inc(ex, `${r.timeout ? 'timeout ' + r.timeout : 'exit ' + r.exit.code + '/' + r.exit.signal} ${/heap out of memory/.test(r.exit.stderr) ? 'OOM' : /Maximum call stack/.test(r.exit.stderr) ? 'stack' : ''}`)
  out('worker exits', ex)
}
if ('all' === section || 'compare' === section) {
  let docs = 0, mism = 0
  const cls = {}
  for (const r of R) {
    if (!r.compare) continue
    docs++
    if (r.compare.n) mism++
    for (const [k, g] of Object.entries(r.compare.classes ?? {})) {
      const c = (cls[k] ??= { docs: 0, n: 0, smallest: null })
      c.docs++; c.n += g.n
      if (!c.smallest || r.size < c.smallest.size) c.smallest = { size: r.size, path: r.path, sample: g.samples[0] }
    }
  }
  out('tree compare', { compared: docs, withDiffs: mism })
  out('diff classes', cls)
  const gcls = {}
  for (const r of R) for (const [k, g] of Object.entries(r.grammar?.classes ?? {})) { const c = (gcls[k] ??= { docs: 0, n: 0, smallest: null }); c.docs++; c.n += g.n; if (!c.smallest || r.size < c.smallest.size) c.smallest = { size: r.size, path: r.path, sample: g.samples[0] } }
  out('JSON grammar-path diff classes', gcls)
}
if ('all' === section || 'resolve' === section) {
  const o = {}, status = {}, why = {}, whyDocs = {}, kinds = {}, checks = {}, conn = {}, connMissing = {}
  let cuts = 0, cutDocs = 0, sites = 0, n = 0, anyExt = 0
  const forms = {}, formDocs = {}
  for (const r of R) {
    if (!r.resolve) { if (isDesc(r) && r.parse?.ok) inc(o, 'no-record:' + (r.timeout ?? 'exit')); continue }
    if (r.resolve.skipped) { inc(o, 'skipped:' + r.resolve.skipped); continue }
    if (!r.resolve.ok) { inc(o, 'threw ' + r.resolve.err?.code + ' ' + (r.resolve.err?.code ? '' : r.resolve.err?.msg)); continue }
    inc(o, 'ok'); n++
    sites += r.resolve.sites
    for (const [k, v] of Object.entries(r.resolve.status)) inc(status, k, v)
    for (const [k, v] of Object.entries(r.resolve.kinds)) inc(kinds, k, v)
    for (const [k, v] of Object.entries(r.resolve.why)) { inc(why, k, v); inc(whyDocs, k) }
    for (const [k, v] of Object.entries(r.resolve.connections ?? {})) inc(conn, k, v)
    for (const [k, v] of Object.entries(r.resolve.connMissing ?? {})) inc(connMissing, k, v)
    cuts += r.resolve.cuts; if (r.resolve.cuts) cutDocs++
    if (r.resolve.why.external) anyExt++
    for (const [k, v] of Object.entries(r.resolve.ext?.forms ?? {})) { inc(forms, k, v); inc(formDocs, k) }
    for (const [w, g] of Object.entries(r.resolve.checks ?? {})) {
      checks[w] ??= { n: 0, verdicts: {}, samples: [] }
      checks[w].n += g.n
      for (const [k, v] of Object.entries(g.verdicts)) inc(checks[w].verdicts, k, v)
      for (const s of g.samples) if (checks[w].samples.filter((x) => x.verdict === s.verdict).length < 4) checks[w].samples.push({ ...s, path: r.path, size: r.size })
    }
  }
  out('resolve outcome', o)
  out('resolve totals', { resolvedDocs: n, sites, status, kinds, cuts, cutDocs, unresolvedByWhy: why, docsWithWhy: whyDocs, docsWithExternal: anyExt })
  out('external forms (refs, docs)', Object.fromEntries(Object.entries(forms).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, [v, formDocs[k]]])))
  out('checks', checks)
  out('connections (count, not found)', Object.fromEntries(Object.entries(conn).map(([k, v]) => [k, [v, connMissing[k] ?? 0]])))
}
if ('all' === section || 'features' === section) {
  const f = { docs: 0, anchors: 0, aliases: 0, mergeKeys: 0, tags: 0, multiDoc: 0, docStart: 0, docEnd: 0, directives: 0, nonStringKeys: 0, complexKeys: 0, flow: 0, blockScalars: 0 }
  const nsk = {}, tagNames = {}
  for (const r of R) {
    const x = r.meta?.features; if (!x) continue
    f.docs++
    if (x.anchors) f.anchors++
    if (x.aliases) f.aliases++
    if (x.mergeKeys) f.mergeKeys++
    if (x.tags) f.tags++
    if (x.docs > 1) f.multiDoc++
    if (x.docStart) f.docStart++
    if (x.docEnd) f.docEnd++
    if (x.directives) f.directives++
    if (Object.keys(x.nonStringKeys).length) f.nonStringKeys++
    if (x.complexKeys) f.complexKeys++
    if (x.flowCollections) f.flow++
    if (x.blockScalars) f.blockScalars++
    for (const k of Object.keys(x.nonStringKeys)) inc(nsk, k)
    for (const k of Object.keys(x.tagNames)) inc(tagNames, k)
  }
  out('YAML feature use (documents using each)', { ...f, nonStringKeyTypes: nsk, tagNames })
}
if ('all' === section || 'perf' === section) {
  const rows = R.filter((r) => r.parse?.ok).map((r) => ({ size: r.size, p: r.parse.ms, r: r.resolve?.ms, fmt: r.meta.format, path: r.path, rss: r.parse.rssKiB, rrss: r.resolve?.rssKiB }))
  const buckets = [[0, 1e4], [1e4, 1e5], [1e5, 1e6], [1e6, 4e6], [4e6, 1e9]]
  const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) }
  const tbl = []
  for (const fmt of ['yaml', 'json']) for (const [lo, hi] of buckets) {
    const b = rows.filter((x) => x.fmt === fmt && x.size >= lo && x.size < hi)
    if (!b.length) continue
    const mbps = b.map((x) => x.size / 1e3 / x.p) // KB/ms = MB/s
    tbl.push({ fmt, bytes: `${lo}-${hi}`, n: b.length, parseMs_p50: q(b.map((x) => x.p), 0.5), p90: q(b.map((x) => x.p), 0.9), max: q(b.map((x) => x.p), 1 - 1e-9), MBps_p50: q(mbps, 0.5), resolveMs_p50: q(b.filter((x) => x.r != null).map((x) => x.r), 0.5), resolve_p90: q(b.filter((x) => x.r != null).map((x) => x.r), 0.9), resolve_max: q(b.filter((x) => x.r != null).map((x) => x.r), 1 - 1e-9) })
  }
  out('timing by size', tbl.map((t) => JSON.stringify(t)).join('\n'))
  const slow = rows.slice().sort((a, b) => b.p - a.p).slice(0, 12).map((x) => `${x.p.toFixed(0)}ms parse, ${x.r?.toFixed(0)}ms resolve, ${(x.size / 1e6).toFixed(2)}MB ${x.fmt}, ${(x.size / 1e3 / x.p).toFixed(3)}MB/s, maxRSS ${Math.round(x.rss / 1024)}MiB ${x.path}`)
  out('slowest parses', slow.join('\n'))
  const slowR = rows.filter((x) => x.r != null).sort((a, b) => b.r - a.r).slice(0, 12).map((x) => `${x.r.toFixed(0)}ms resolve, ${x.p.toFixed(0)}ms parse, ${(x.size / 1e6).toFixed(2)}MB ${x.fmt} ${x.path}`)
  out('slowest resolves', slowR.join('\n'))
  const mem = rows.slice().sort((a, b) => (b.rrss ?? b.rss) - (a.rrss ?? a.rss)).slice(0, 10).map((x) => `${Math.round((x.rrss ?? x.rss) / 1024)}MiB maxRSS (after parse ${Math.round(x.rss / 1024)}MiB), ${(x.size / 1e6).toFixed(2)}MB ${x.fmt} ${x.path}`)
  out('peak memory', mem.join('\n'))
  // speed ratio outliers: lowest MB/s among docs > 50KB
  const outl = rows.filter((x) => x.size > 5e4 && x.fmt === 'yaml').sort((a, b) => a.size / a.p - b.size / b.p).slice(0, 10).map((x) => `${(x.size / 1e3 / x.p).toFixed(3)}MB/s ${x.p.toFixed(0)}ms ${(x.size / 1e6).toFixed(2)}MB ${x.path}`)
  out('slowest per byte (YAML > 50KB)', outl.join('\n'))
}
