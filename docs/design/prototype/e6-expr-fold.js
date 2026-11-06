// E6: the OpenAPI resolver written over expr's tree layer (key operators
// and `fold`), from the expr checkout's build. Everything OpenAPI knows
// is in this file; everything generic (shape recognition, the walk, the
// inherited bag, memo, cycles, the report, positions) is expr's.
//
// Needs the expr tree layer (tabnas/expr PR 100). Until it is published,
// set TABNAS_EXPR to a checkout's ts/ directory and put that checkout's
// ts/node_modules and a directory holding @tabnas/parser, jsonic and yaml
// on NODE_PATH.
const fs = require('fs')
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { Expr, fold } = require(process.env.TABNAS_EXPR || '@tabnas/expr')

const isRecord = (v) => null != v && 'object' === typeof v && !Array.isArray(v)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// ---- OpenAPI knowledge ----------------------------------------------
const op = {
  ref: { key: true, src: '$ref' },
  dynamicRef: { key: true, src: '$dynamicRef', dynamic: true },
}

function docVersion(root) {
  if (!isRecord(root)) return 'unknown'
  if (null != root.swagger) return '2.0'
  const v = String(root.openapi || '')
  return v.startsWith('3.0') ? '3.0' : v.startsWith('3.') ? '3.1+' : 'unknown'
}

const SCHEMA_TAIL = /(^|\u0000)(schemas\u0000[^\u0000]+|definitions\u0000[^\u0000]+|schema|items|additionalProperties|contains|propertyNames|not|if|then|else|contentSchema|unevaluatedItems|unevaluatedProperties|properties\u0000[^\u0000]+|patternProperties\u0000[^\u0000]+|dependentSchemas\u0000[^\u0000]+|\$defs\u0000[^\u0000]+|(allOf|oneOf|anyOf|prefixItems)\u0000\d+)$/
function kindAt(path) {
  for (let i = 0; i < path.length; i++) {
    const k = String(path[i])
    if (k.startsWith('x-') || 'example' === k || 'const' === k || 'enum' === k) return 'data'
    if ('default' === k && 'responses' !== path[i - 1]) return 'data'
    if ('value' === k && 'examples' === path[i - 2]) return 'data'
  }
  if (2 === path.length && ('paths' === path[0] || 'webhooks' === path[0])) return 'pathItem'
  if (3 === path.length && 'components' === path[0] && 'pathItems' === path[1]) return 'pathItem'
  if (SCHEMA_TAIL.test(path.join('\u0000'))) return 'schema'
  return 'reference'
}

function resolveUri(base, ref) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref
  const hash = ref.indexOf('#')
  const refPath = hash < 0 ? ref : ref.slice(0, hash)
  const frag = hash < 0 ? '' : ref.slice(hash)
  const baseNoFrag = base.replace(/#.*$/, '')
  return '' === refPath ? baseNoFrag + frag : baseNoFrag.replace(/[^/]*$/, '') + refPath + frag
}
function pointerParts(frag) {
  let p; try { p = decodeURIComponent(frag) } catch (_e) { return null }
  if ('' === p) return []
  if (!p.startsWith('/')) return null
  return p.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

// `$self`, `$id` and `$anchor` targets, indexed once over the raw tree;
// a resource's base is its nearest `$id`, then the document's `$self`.
function indexIds(root, retrievalUri) {
  const ids = new Map()
  const base0 = 'string' === typeof root.$self ? resolveUri(retrievalUri, root.$self) : retrievalUri
  const walk = (node, path, base) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, [...path, i], base))
    if (!isRecord(node)) return
    const id = 'string' === typeof node.$id ? node.$id : path.length ? null : ('string' === typeof node.$self ? node.$self : null)
    if (id) { base = resolveUri(base, id); ids.set(base.replace(/#.*$/, ''), path) }
    if ('string' === typeof node.$anchor) ids.set(base.replace(/#.*$/, '') + '#' + node.$anchor, path)
    for (const k of Object.keys(node)) walk(node[k], [...path, k], base)
  }
  walk(root, [], base0)
  return { ids, base0 }
}

function combine(hit, siblings, kind, version) {
  const keys = Object.keys(siblings)
  if (!isRecord(hit) || 0 === keys.length) return hit
  if ('2.0' === version) return hit
  if ('pathItem' === kind) return { ...hit, ...siblings }
  if ('schema' === kind && '3.1+' === version) { const { allOf = [], ...rest } = siblings; return { allOf: [hit, ...allOf], ...rest } }
  const out = { ...hit }
  if ('3.0' !== version) for (const k of ['summary', 'description']) if (own(siblings, k)) out[k] = siblings[k]
  return out
}

// The fold options for one document: OpenAPI's vocabulary over expr's
// generic fold. `unresolved` beyond the fold's own report (an external
// document, a data slot) is recorded here.
function openapiFold(raw, { retrievalUri = 'urn:uuid:entry', positions } = {}) {
  const version = docVersion(raw)
  const { ids, base0 } = indexIds(raw, retrievalUri)
  const extra = { external: [], provenance: [] }
  let report
  const options = {
    op,
    positions,
    k: { base: base0 },
    inherit: (site, node, k) => {
      const id = 'string' === typeof node.$id ? node.$id : (0 === site.path.length && 'string' === typeof node.$self ? node.$self : null)
      return { ...k, base: id ? resolveUri(k.base, id) : k.base, kind: kindAt(site.path) }
    },
    evaluate: (site, o, [uri, siblings]) => {
      if (!o.key) return NaN
      if ('data' === site.k.kind || 'string' !== typeof uri) return site.node
      const abs = resolveUri(site.k.base, uri)
      const hash = abs.indexOf('#')
      const doc = hash < 0 ? abs : abs.slice(0, hash)
      const frag = hash < 0 ? '' : abs.slice(hash + 1)
      let start = []
      if (doc !== base0.replace(/#.*$/, '')) {
        if (!ids.has(doc)) { extra.external.push({ at: site.path, uri: abs }); return site.node }
        start = ids.get(doc)
      }
      let target
      if ('' === frag || frag.startsWith('/')) { const parts = pointerParts(frag); if (null == parts) return site.node; target = [...start, ...parts] }
      else if (ids.has(doc + '#' + frag)) target = ids.get(doc + '#' + frag)
      else return site.node
      const hit = site.at(target)
      extra.provenance.push({ at: site.path, ref: uri, kind: site.k.kind, line: site.token && site.token.rI, col: site.token && site.token.cI })
      if (!hit.found || hit.cycle) return site.node
      return combine(hit.value, siblings, site.k.kind, version)
    },
    report: (r) => { report = r },
  }
  const tree = fold(raw, options)
  return { tree, version, report, ...extra }
}

module.exports = { openapiFold, op }
if (require.main !== module) return

const show = (label, v) => console.log(label, JSON.stringify(v))
const yamlSrc = fs.readFileSync(process.argv[2] || __dirname + '/e6-doc.yaml', 'utf8')
const tn = new Tabnas().use(jsonic).use(Yaml)
const raw = tn.parse(yamlSrc)
const rawText = JSON.stringify(raw)
const t0 = Date.now()
const out = openapiFold(raw, { retrievalUri: 'https://api.example.com/openapi.yaml' })
console.log(`fold: ${Date.now() - t0} ms; version ${out.version}; raw unchanged: ${JSON.stringify(raw) === rawText}; serialises: ${'string' === typeof JSON.stringify(out.tree)}`)
if (out.tree.paths) {
  const r = out.tree
  show('parameters[0] (block-sequence entry, by shape) =', r.paths['/pets'].get.parameters[0])
  show('/pets 200 (Reference Object override) =', r.paths['/pets'].get.responses['200'])
  show('/pets 404 (ref -> ref) =', r.paths['/pets'].get.responses['404'])
  console.log('/pets/{id} 200 is /pets 200\'s one result:', r.paths['/pets/{id}'].get.responses['200'] === r.paths['/pets'].get.responses['200'])
  show('/pets/{id}/photos (Path Item merge) =', r.paths['/pets/{id}/photos'])
  show('requestBody schema (target under a $id, reached first: its own base) =', r.paths['/pets'].get.requestBody.content['application/json'].schema)
  show('Pet.tag (3.1 Schema Object conjunction) =', r.components.schemas.Pet.properties.tag)
  show('Pet.name (#name anchor) =', r.components.schemas.Pet.properties.name)
  show('Pet.friends.items (cycle) =', r.components.schemas.Pet.properties.friends.items)
  show('Pet.any ($dynamicRef, verbatim) =', r.components.schemas.Pet.properties.any)
  show('Pet.owner (external) =', r.components.schemas.Pet.properties.owner)
  show('Encoded (%2F) =', r.components.schemas.Encoded)
  show('x-vendor (data) =', r['x-vendor'])
  show('example (data) =', r.components.responses.PetList.content['application/json'].example)
  console.log('__proto__ kept:', Object.keys(r.components.schemas).includes('__proto__'))
  show('report =', out.report)
  show('external =', out.external)
  console.log('provenance entries:', out.provenance.length)
  const v30 = openapiFold(Object.assign(Object.create(null), raw, { openapi: '3.0.3' }), { retrievalUri: 'https://api.example.com/openapi.yaml' })
  show('as 3.0.3: Pet.tag =', v30.tree.components.schemas.Pet.properties.tag)
}
