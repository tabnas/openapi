// E6: the OpenAPI resolver written over expr's tree layer (key operators
// and `fold`). Everything OpenAPI knows is in this file; everything
// generic (shape recognition, the walk, the inherited bag, memory,
// cycles, several documents, the report, positions) is expr's.
//
// Needs the expr tree layer (tabnas/expr pull request 100). Until it is
// published, set TABNAS_EXPR to a checkout's ts/ directory and put that
// checkout's ts/node_modules and a directory holding @tabnas/parser,
// jsonic and yaml on NODE_PATH.
//
//   node e6-expr-fold.js                 the YAML document beside this file
//   node e6-expr-fold.js spec3.json      a JSON description, read with JSON.parse:
//                                        one summary line (Stripe's, for the docs)
const fs = require('fs')
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { fold, recordPositions } = require(process.env.TABNAS_EXPR || '@tabnas/expr')

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
  return v.startsWith('3.0') ? '3.0' : v.startsWith('3.1') ? '3.1' : v.startsWith('3.') ? '3.2' : 'unknown'
}
// JSON Schema 2020-12 identifiers ($id, $anchor, $dynamicAnchor) exist in
// OpenAPI from 3.1; $self from 3.2. 3.0 and 2.0 resolve a relative
// reference against the document's own URI.
const hasIds = (v) => '3.1' === v || '3.2' === v
const hasSelf = (v) => '3.2' === v

// What a position in a description holds, from the path alone, segment
// by segment (never a joined string, so no member name can forge a
// boundary). A sketch of the plan's object model: it knows which keys
// hold a map of author-chosen names, which hold one object of a type or a
// list of them, and which hold data, and it never reads a name as a
// keyword. `kind` is 'schema', 'object', 'names' (a map of names, never
// an operation however its members are named) or 'data'; `type` is the
// OpenAPI object type where known.
const NAMED = {
  paths: 'pathItem', webhooks: 'pathItem', responses: 'response', callbacks: 'callback',
  content: 'mediaType', encoding: 'encoding', headers: 'header', links: 'link',
  examples: 'example', variables: 'serverVariable', securitySchemes: 'securityScheme',
  additionalOperations: 'operation', mapping: 'data', scopes: 'data',
}
const COMPONENT = {
  schemas: 'schema', responses: 'response', parameters: 'parameter', examples: 'example',
  requestBodies: 'requestBody', headers: 'header', securitySchemes: 'securityScheme',
  links: 'link', callbacks: 'callback', pathItems: 'pathItem', mediaTypes: 'mediaType',
}
const SWAGGER_NAMED = { definitions: 'schema', parameters: 'parameter', responses: 'response', securityDefinitions: 'securityScheme' }
const LISTED = { parameters: 'parameter', tags: 'tag', servers: 'server', security: 'securityRequirement' }
const SINGLE = {
  requestBody: 'requestBody', info: 'info', externalDocs: 'externalDocs', discriminator: 'discriminator',
  get: 'operation', put: 'operation', post: 'operation', delete: 'operation', options: 'operation',
  head: 'operation', patch: 'operation', trace: 'operation', query: 'operation',
}
const SCHEMA_ONE = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains',
  'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema'])
const SCHEMA_MAP = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const SCHEMA_LIST = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SCHEMA_DATA = new Set(['example', 'examples', 'const', 'enum', 'default'])

const SCHEMA = { kind: 'schema', type: 'schema' }
const DATA = { kind: 'data' }
const obj = (type) => 'schema' === type ? SCHEMA : 'data' === type ? DATA : { kind: 'object', type }

function classify(path, version) {
  let at = { kind: 'object', type: 'root' }
  let next // for 'names' and 'list': what each member holds
  for (const s of path) {
    const seg = String(s)
    if ('data' === at.kind) return DATA
    if ('names' === at.kind || 'list' === at.kind) { at = next; continue }
    if ('components' === at.kind) {
      at = own(COMPONENT, seg) ? { kind: 'names' } : DATA
      next = obj(COMPONENT[seg])
      continue
    }
    if (seg.startsWith('x-')) return DATA
    if ('schema' === at.kind) {
      if (SCHEMA_DATA.has(seg)) return DATA
      if (SCHEMA_ONE.has(seg)) continue
      if (SCHEMA_MAP.has(seg)) { at = { kind: 'names' }; next = SCHEMA; continue }
      if (SCHEMA_LIST.has(seg)) { at = { kind: 'list' }; next = SCHEMA; continue }
      if ('discriminator' === seg || 'xml' === seg || 'externalDocs' === seg) { at = obj(seg); continue }
      return DATA // any other keyword holds plain JSON
    }
    // A keyword of an OpenAPI object.
    if ('example' === seg) return DATA
    if ('example' === at.type && ('value' === seg || 'dataValue' === seg || 'serializedValue' === seg)) return DATA
    if ('serverVariable' === at.type && ('default' === seg || 'enum' === seg)) return DATA
    if ('link' === at.type && ('parameters' === seg || 'requestBody' === seg)) return DATA
    if ('callback' === at.type) { at = obj('pathItem'); continue } // an expression names a Path Item
    if ('root' === at.type && 'components' === seg) { at = { kind: 'components' }; continue }
    if ('root' === at.type && '2.0' === version && own(SWAGGER_NAMED, seg)) {
      at = { kind: 'names' }; next = obj(SWAGGER_NAMED[seg]); continue
    }
    if ('schema' === seg || ('2.0' === version && 'items' === seg)) { at = SCHEMA; continue }
    if (own(NAMED, seg)) { at = { kind: 'names' }; next = obj(NAMED[seg]); continue }
    if (own(LISTED, seg)) { at = { kind: 'list' }; next = obj(LISTED[seg]); continue }
    at = obj(own(SINGLE, seg) ? SINGLE[seg] : 'unknown')
  }
  return at
}

// A Reference Object's `summary` and `description` override the target's
// only where the target's type has the field (3.1 section 4.8.23; 3.2
// adds `summary` to the Response and Tag objects and `description` to the
// Media Type object, per the OAI validation schemas).
const OVERRIDE_31 = {
  response: ['description'], parameter: ['description'], example: ['summary', 'description'],
  requestBody: ['description'], header: ['description'], link: ['description'],
  securityScheme: ['description'], pathItem: ['summary', 'description'],
}
const OVERRIDE = {
  '3.1': OVERRIDE_31,
  '3.2': { ...OVERRIDE_31, response: ['summary', 'description'], mediaType: ['description'], tag: ['summary', 'description'] },
}

// RFC 3986 section 5.2: reference resolution against a base URI.
function parseUri(u) {
  const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(u)
  return { scheme: m[1], authority: m[2], path: m[3], query: m[4], fragment: m[5] }
}
function removeDots(input) {
  let out = ''
  while (input.length) {
    if (input.startsWith('../')) input = input.slice(3)
    else if (input.startsWith('./')) input = input.slice(2)
    else if (input.startsWith('/./')) input = input.slice(2)
    else if ('/.' === input) input = '/'
    else if (input.startsWith('/../') || '/..' === input) {
      input = '/' + input.slice(4)
      out = out.slice(0, Math.max(0, out.lastIndexOf('/')))
    }
    else if ('.' === input || '..' === input) input = ''
    else {
      const seg = /^\/?[^/]*/.exec(input)[0]
      out += seg
      input = input.slice(seg.length)
    }
  }
  return out
}
function resolveUri(base, ref) {
  const r = parseUri(ref)
  const b = parseUri(base)
  const t = {}
  if (undefined !== r.scheme) {
    Object.assign(t, { scheme: r.scheme, authority: r.authority, path: removeDots(r.path), query: r.query })
  }
  else {
    if (undefined !== r.authority) {
      Object.assign(t, { authority: r.authority, path: removeDots(r.path), query: r.query })
    }
    else {
      if ('' === r.path) {
        t.path = b.path
        t.query = undefined !== r.query ? r.query : b.query
      }
      else {
        const merged = r.path.startsWith('/') ? r.path
          : undefined !== b.authority && '' === b.path ? '/' + r.path
            : b.path.slice(0, b.path.lastIndexOf('/') + 1) + r.path
        t.path = removeDots(merged)
        t.query = r.query
      }
      t.authority = b.authority
    }
    t.scheme = b.scheme
  }
  t.fragment = r.fragment
  return (undefined !== t.scheme ? t.scheme + ':' : '') + (undefined !== t.authority ? '//' + t.authority : '')
    + t.path + (undefined !== t.query ? '?' + t.query : '') + (undefined !== t.fragment ? '#' + t.fragment : '')
}
const withoutFragment = (u) => u.replace(/#.*$/, '')

// A URI fragment as JSON Pointer segments: percent-decoded whole first,
// then split, then `~1` and `~0` (RFC 6901 section 6). Null when it is not
// a pointer. Array indices are checked by the fold, which names nothing
// for `01` or `-`.
function pointerParts(frag) {
  let p
  try { p = decodeURIComponent(frag) } catch (_e) { return null }
  if ('' === p) return []
  if (!p.startsWith('/')) return null
  return p.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

// The `$id`, `$anchor` and `$dynamicAnchor` targets of one document,
// indexed once over the raw tree, in schema positions only (a `$anchor`
// inside example data is data), and only in the versions that have them.
function indexIds(root, docUri, version) {
  const ids = new Map()
  if (!hasIds(version)) return ids
  const walk = (node, path, base) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, [...path, i], base))
    if (!isRecord(node)) return
    const c = classify(path, version)
    if ('data' === c.kind) return
    if ('schema' === c.kind) {
      if ('string' === typeof node.$id) {
        base = resolveUri(base, node.$id)
        ids.set(withoutFragment(base), path)
      }
      for (const a of ['$anchor', '$dynamicAnchor']) {
        if ('string' === typeof node[a]) ids.set(withoutFragment(base) + '#' + node[a], path)
      }
    }
    for (const k of Object.keys(node)) walk(node[k], [...path, k], base)
  }
  walk(root, [], docUri)
  return ids
}

// The sibling rule, by the site's kind and the version.
function combine(hit, siblings, site, version, targetType) {
  if (!isRecord(hit) || 0 === Object.keys(siblings).length) return hit
  // A Path Item's $ref is a field of the Path Item in every version,
  // Swagger 2.0 included: the fields merge.
  if ('pathItem' === site.type) return { ...hit, ...siblings }
  // 2.0 JSON Reference and 3.0 Reference Object: siblings are ignored.
  if ('2.0' === version || '3.0' === version) return hit
  // 3.1 and later: a Schema Object's $ref is an applicator, its siblings
  // apply beside it.
  if ('schema' === site.kind) {
    const { allOf = [], ...rest } = siblings
    return { allOf: [hit, ...allOf], ...rest }
  }
  const out = { ...hit }
  for (const k of (OVERRIDE[version] || {})[targetType] || []) {
    if (own(siblings, k)) out[k] = siblings[k]
  }
  return out
}

// The fold options for one description: OpenAPI's vocabulary over expr's
// generic fold. `documents` holds other documents by URI, standing in for
// a loader: the fold asks for each at most once.
function openapiFold(raw, { retrievalUri = 'urn:uuid:entry', positions, documents = {} } = {}) {
  const version = docVersion(raw)
  const selfUri = hasSelf(version) && isRecord(raw) && 'string' === typeof raw.$self
    ? resolveUri(retrievalUri, raw.$self) : retrievalUri
  const entry = withoutFragment(selfUri)
  const retrieved = withoutFragment(retrievalUri)
  const ids = indexIds(raw, entry, version)
  const extra = { unresolved: [], provenance: [], dataSlots: 0, loads: [] }
  let report
  const options = {
    op,
    doc: entry,
    positions,
    k: {},
    load: (uri) => { extra.loads.push(uri); return documents[uri] },
    inherit: (site, node, k) => {
      const c = classify(site.path, version)
      let base = 0 === site.path.length ? site.doc : k.base
      if ('schema' === c.kind && hasIds(version) && 'string' === typeof node.$id) base = resolveUri(base, node.$id)
      return { ...k, base, kind: c.kind, type: c.type }
    },
    // A map that owns $ref is a reference only where an object or a schema
    // stands: in data, or as a name in a map of names, it is data.
    recognise: (site, o) => {
      const data = 'data' === site.k.kind || 'names' === site.k.kind
      if (data && '$ref' === o.src) extra.dataSlots++
      return !data
    },
    evaluate: (site, o, [uri, siblings]) => {
      if (!o.key) return NaN
      const why = (reason) => { extra.unresolved.push({ at: site.path, ref: uri, why: reason }) }
      if ('string' !== typeof uri) { why('not a string'); return site.plain() }
      const abs = resolveUri(site.k.base, uri)
      const doc = withoutFragment(abs)
      const hash = abs.indexOf('#')
      const frag = hash < 0 ? '' : abs.slice(hash + 1)
      // This document by its URI, an embedded resource by its $id, or
      // another document by its URI.
      let key, start = []
      if (ids.has(doc)) start = ids.get(doc)
      else if (doc !== entry && doc !== retrieved) key = doc
      let target
      if ('' === frag || frag.startsWith('/') || frag.startsWith('%2F') || frag.startsWith('%2f')) {
        const parts = pointerParts(frag)
        if (null === parts) { why('not a JSON Pointer'); return site.node }
        target = [...start, ...parts]
      }
      else if (/^[A-Za-z_][-A-Za-z0-9._]*$/.test(frag)) {
        const named = ids.get(doc + '#' + frag)
        if (undefined === named) { why('no such anchor'); return site.node }
        target = named
      }
      else { why('not a JSON Pointer'); return site.node }
      const hit = site.at(target, key)
      extra.provenance.push({
        at: site.path, ref: uri, kind: site.k.kind,
        line: site.token && site.token.rI, col: site.token && site.token.cI,
      })
      if (!hit.found || hit.cycle) return site.node
      return combine(hit.value, siblings, site.k, version, classify(target, version).type)
    },
    report: (r) => { report = r },
  }
  const tree = fold(raw, options)
  return { tree, version, report, ...extra }
}

module.exports = { openapiFold, op, classify, resolveUri }
if (require.main !== module) return

const show = (label, v) => console.log(label, JSON.stringify(v))
const file = process.argv[2] || __dirname + '/e6-doc.yaml'
const text = fs.readFileSync(file, 'utf8')

if (file.endsWith('.json')) {
  // A large JSON description: JSON.parse, no grammar, one summary line.
  const raw = JSON.parse(text)
  const t0 = Date.now()
  const out = openapiFold(raw, { retrievalUri: 'https://example.com/' + require('path').basename(file) })
  const ms = Date.now() - t0
  console.log(`${require('path').basename(file)} via expr.fold on JSON.parse output: ${ms} ms in this container;`
    + ` version ${out.version}; sites ${out.provenance.length}; $ref maps left as data ${out.dataSlots};`
    + ` cycles ${out.report.cycles.length}; unresolved ${out.report.unresolved.length + out.unresolved.length};`
    + ` dynamic ${out.report.dynamic.length}; documents loaded ${out.loads.length}`)
  return
}

const tn = new Tabnas().use(jsonic).use(Yaml)
const positions = recordPositions(tn)
const raw = tn.parse(text)
const rawText = JSON.stringify(raw)
const documents = {
  'https://example.com/schemas/person.json': { type: 'object', properties: { name: { type: 'string' } } },
}
const t0 = Date.now()
const out = openapiFold(raw, { retrievalUri: 'https://api.example.com/v1/openapi.yaml', positions, documents })
console.log(`fold: ${Date.now() - t0} ms; version ${out.version}; raw unchanged: ${JSON.stringify(raw) === rawText};`
  + ` serialises: ${'string' === typeof JSON.stringify(out.tree)}`)
const r = out.tree
const S = r.components.schemas
show('parameters[0] (block-sequence entry, by shape) =', r.paths['/pets'].get.parameters[0])
show('/pets 200 (3.2 Response: summary and description override) =',
  { summary: r.paths['/pets'].get.responses['200'].summary, description: r.paths['/pets'].get.responses['200'].description })
show('/pets 404 (ref -> ref) =', r.paths['/pets'].get.responses['404'])
console.log('/pets/{id} 200 is /pets 200\'s one result:', r.paths['/pets/{id}'].get.responses['200'] === r.paths['/pets'].get.responses['200'])
show('/pets/{id}/photos (Path Item merge) =', r.paths['/pets/{id}/photos'])
show('requestBody schema (target under a $id, reached first: its own base) =', r.paths['/pets'].get.requestBody.content['application/json'].schema)
show('Pet.tag (3.1+ Schema Object conjunction) =', S.Pet.properties.tag)
show('Pet.sibling (../v1/owner.json, dot segments removed) =', S.Pet.properties.sibling)
show('Pet.name (#name anchor) =', S.Pet.properties.name)
show('Pet.example (a property named example is a schema) =', S.Pet.properties.example)
show('Pet.friends.items (cycle through the Pet schema: cut) =', S.Pet.properties.friends.items)
show('Pet.any ($dynamicRef, left as written) =', S.Pet.properties.any)
show('Pet.owner (another document, through load) =', S.Pet.properties.owner)
show('Encoded (%2F) =', S.Encoded)
show('Ids.properties (a property named $ref is a name) =', S.Ids.properties)
show('Odd (a $ref that is not a string: the map, folded) =', S.Odd)
show('x-vendor (data) =', r['x-vendor'])
show('example (data) =', r.components.responses.PetList.content['application/json'].example)
console.log('__proto__ kept:', Object.keys(S).includes('__proto__'))
show('fold report =', out.report)
show('E6 unresolved =', out.unresolved.map((u) => ({ at: u.at.join('/'), ref: u.ref, why: u.why })))
show('documents loaded =', out.loads)
console.log('$ref maps left as data:', out.dataSlots, '; provenance entries:', out.provenance.length,
  '; with a position:', out.provenance.filter((p) => undefined !== p.line).length)
show('first provenance entry =', out.provenance[0])

// The same document read as 3.0.3: no $id, no $self, no anchors.
const as30 = openapiFold(Object.assign(Object.create(null), raw, { openapi: '3.0.3' }),
  { retrievalUri: 'https://api.example.com/v1/openapi.yaml', documents })
show('as 3.0.3: Pet.tag (tag.json against the document URI) =', as30.tree.components.schemas.Pet.properties.tag)
show('as 3.0.3: unresolved =', as30.report.unresolved.map((u) => u.targetDoc + '#' + u.target))

// Swagger 2.0: a Path Item's $ref merges its fields there too.
const v2 = openapiFold({
  swagger: '2.0',
  paths: { '/p': { $ref: '#/x-items/P', get: { responses: { 200: { description: 'ok' } } } } },
  'x-items': { P: { post: { responses: { 200: { description: 'ok' } } } } },
})
show('2.0 Path Item merge =', v2.tree.paths['/p'])
