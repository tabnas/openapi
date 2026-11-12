#!/usr/bin/env node
'use strict'
// External reference census: what the `external` references name.
// usage: node ext-analyze.cjs <results.jsonl>
const Fs = require('node:fs'), Path = require('node:path')
const YAML = require(process.env.YAML_REF || 'yaml')
const R = Fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n }
const cache = new Map()
function kindOfFile(p) {
  if (cache.has(p)) return cache.get(p)
  let k
  try {
    const t = Fs.readFileSync(p, 'utf8')
    let v
    try { v = JSON.parse(t) } catch { v = YAML.parse(t, { uniqueKeys: false, maxAliasCount: -1 }) }
    if (null == v || 'object' !== typeof v || Array.isArray(v)) k = 'non-map-file'
    else if ('openapi' in v || 'swagger' in v) k = 'openapi-document'
    else if ('$schema' in v) k = 'json-schema-with-$schema'
    else if (['type', 'properties', 'allOf', 'oneOf', 'anyOf', 'items', 'enum', '$ref'].some((x) => x in v)) k = 'schema-like-fragment'
    else if (['get', 'post', 'put', 'delete', 'patch', 'parameters'].some((x) => x in v)) k = 'path-item-like-fragment'
    else if (['description', 'content', 'schema'].some((x) => x in v)) k = 'response/parameter-like-fragment'
    else k = 'map-of-definitions-or-other'
  } catch (e) { k = Fs.existsSync(p) ? 'unreadable' : 'missing-file' }
  cache.set(p, k)
  return k
}
const targets = {}, hosts = {}, docsUsing = {}, perSource = {}
let docsWithExt = 0
for (const r of R) {
  const refs = r.resolve?.ext?.refs
  perSource[r.source] ??= { resolved: 0, withExternal: 0 }
  if (r.resolve?.ok) perSource[r.source].resolved++
  if (!refs || !Object.keys(refs).length) continue
  docsWithExt++; perSource[r.source].withExternal++
  const seenKinds = new Set()
  for (const [docPart, n] of Object.entries(refs)) {
    let k
    if (/^[a-z][a-z0-9+.-]*:/i.test(docPart)) {
      const u = (() => { try { return new URL(docPart) } catch { return null } })()
      k = 'absolute:' + (u ? u.protocol : 'bad')
      if (u) inc(hosts, u.host, n)
    } else {
      const p = Path.resolve(Path.dirname(r.path), decodeURIComponent(docPart))
      k = 'relative->' + (p === r.path ? 'SELF' : kindOfFile(p))
    }
    inc(targets, k, n); seenKinds.add(k)
  }
  for (const k of seenKinds) inc(docsUsing, k)
}
console.log(JSON.stringify({ docsWithExt, perSource, targetsByRefCount: targets, docsUsingTargetKind: docsUsing, absoluteHosts: Object.fromEntries(Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 25)) }, null, 1))
