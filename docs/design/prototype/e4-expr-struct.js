// E4: can expr be EXTENDED to carry `$ref`? Three measurements.
//
//  (a) expr's existing lexical model: `$ref` as a token operator. Fails,
//      because the key position belongs to the base grammar's pair rule.
//  (b) A STRUCTURAL operator layer written against expr's public surface
//      (opify, evaluation, simplify): an operator recognised by the SHAPE
//      of a built node (a map with a keyword key) rather than by a token,
//      a tree fold that walks objects, runs at end of parse, carries a
//      site (root, path, token) and an INHERITED environment (the base
//      URI in force, from the nearest `$id`), memoises per source node
//      and keeps a cyclic back edge verbatim. This is what "expr handles
//      trees as well as values" would have to mean; everything here is a
//      candidate addition to ts/src/expr.ts.
//  (c) Where expr's fold has to change for (b): evaluation() over objects.
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { Expr, evaluation, simplify, testing } = require('@tabnas/expr')

const isRecord = (v) => null != v && 'object' === typeof v && !Array.isArray(v)
const show = (label, v, note) => console.log(label, JSON.stringify(v) + (note ? ' ' + note : ''))

// ---------------------------------------------------------------- (a)
console.log('(a) `$ref` as a lexical (token) operator on jsonic+expr')
for (const [desc, ops] of [
  ['prefix op src "$ref"', { refp: { prefix: true, src: '$ref', right: 5000000 } }],
  ['infix op src "$ref"', { refi: { infix: true, src: '$ref', left: 1000000, right: 1100000 } }],
]) {
  const tn = new Tabnas().use(jsonic).use(Expr, { op: ops })
  for (const src of ["{ $ref: '#/x' }", "$ref '#/x'", "{ '$ref': '#/x' }"]) {
    let out
    try { out = JSON.stringify(simplify(tn.parse(src))) } catch (e) { out = 'ERROR ' + e.code }
    console.log(`    ${desc.padEnd(22)} ${src.padEnd(20)} -> ${out}`)
  }
}

// ---------------------------------------------------------------- (b)
// A structural operator definition: `struct: true` and the `key` that
// identifies it. Terms: the key's value, then the sibling map. Candidate
// OpDef fields for expr.
function makeStructOp(name, def) {
  return testing.opify({
    name: name + '-struct', src: def.key, key: def.key, struct: true, terms: 2,
    prefix: false, infix: false, suffix: false, ternary: false, paren: false,
    left: Number.MIN_SAFE_INTEGER, right: Number.MAX_SAFE_INTEGER,
    use: def.use || {}, tkn: '', tin: -1, osrc: '', csrc: '', otkn: '', otin: -1, ctkn: '', ctin: -1,
    preval: { active: false, required: false },
  })
}
const isStructOp = (v) => Array.isArray(v) && null != v[0] && true === v[0].struct

// The layer. `op` entries with `struct: true` are recognised at every
// `val` after-close (a candidate expr hook, beside expr's own val alts);
// `evaluate.when === 'end'` folds at the start rule's after-close. The
// fold is `treeEvaluation`: candidate replacement for expr's evaluation()
// when asked to walk objects.
const ExprStruct = (tn, options) => {
  const structTM = {}
  for (const [name, def] of Object.entries(options.op || {})) if (def && def.struct) structTM[def.key] = makeStructOp(name, def)
  const guard = options.guard || (() => true)

  tn.rule('val', (rs) => rs.ac((r, ctx) => {
    const n = r.node
    if (!isRecord(n)) return
    for (const key of Object.keys(structTM)) {
      if ('string' !== typeof n[key] && !isRecord(n[key])) continue
      if (!guard(ancestorKeys(r, ctx))) return
      const sib = {}
      for (const k of Object.keys(n)) if (key !== k) sib[k] = n[k]
      r.node = [{ ...structTM[key], token: r.o0 }, n[key], sib]
      return
    }
  }))

  if (options.evaluate && 'end' === options.evaluate.when) {
    tn.rule(tn.options.rule.start, (rs) => rs.ac((r) => {
      if (0 !== r.d) return
      r.node = treeEvaluation(r.node, options.evaluate.fn, { root: r.node, env: options.evaluate.env || {} })
    }))
  }
}

function ancestorKeys(r, ctx) {
  const keys = []
  for (let p = r.parent; p && p !== ctx.NORULE; p = p.parent) {
    if (('pair' === p.name || 'yamlElemPair' === p.name) && undefined !== p.u.key) keys.unshift(String(p.u.key))
    else if ('elem' === p.name || 'yamlBlockElem' === p.name) keys.unshift('*')
  }
  return keys
}

// The tree fold. Values flow UP (each operator node is reduced by
// `evaluate`, through expr's own evaluation() so a token-operator tree
// inside a term still reduces); context flows DOWN as `site.env`, which an
// `inherit` callback may extend at each object (the engine's k-bag idea):
// here `$id` sets the base URI for everything beneath it. `site.memo`
// shares one result per source node; `site.walking` detects a cycle met
// top-down; `site.active` a cycle met through a chain of references.
function treeEvaluation(root, evaluate, opts) {
  const site = {
    root, path: [], env: opts.env || {},
    memo: new Map(), walking: new Set(), active: new Set(),
    inherit: opts.inherit || defaultInherit,
    walk: null, locate: null,
  }
  site.walk = (node, path, env) => {
    if (site.memo.has(node)) return site.memo.get(node)
    if (isStructOp(node)) {
      const here = { ...site, path, env, token: node[0].token }
      return evaluation(null, null, node, (_r, _c, op, terms) => evaluate(here, op, terms))
    }
    if (Array.isArray(node)) {
      const out = []
      site.memo.set(node, out); site.walking.add(node)
      node.forEach((v, i) => out.push(site.walk(v, [...path, String(i)], env)))
      site.walking.delete(node)
      return out
    }
    if (isRecord(node)) {
      const out = {}
      site.memo.set(node, out); site.walking.add(node)
      const env2 = site.inherit(node, env, path)
      for (const k of Object.keys(node)) out[k] = site.walk(node[k], [...path, k], env2)
      site.walking.delete(node)
      return out
    }
    return node
  }
  return site.walk(root, [], site.env)
}

// Inherited context: `$id` (JSON Schema 2020-12) and `$self` (OpenAPI
// 3.2) set the base URI beneath them; `$anchor` registers a plain-name
// fragment target in the resource it sits in.
function defaultInherit(node, env, path) {
  let out = env
  const id = 'string' === typeof node.$self ? node.$self : 'string' === typeof node.$id ? node.$id : null
  if (id) out = { ...out, base: resolveUri(env.base || '', id), resource: path }
  if ('string' === typeof node.$anchor) {
    const anchors = out.anchors || (out.anchors = {})
    anchors[(out.base || '') + '#' + node.$anchor] = path
  }
  return out
}

// A small RFC 3986 reference resolution: absolute wins; a fragment-only
// reference keeps the base; a relative path replaces the last segment.
function resolveUri(base, ref) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref
  const hash = ref.indexOf('#')
  const refPath = hash < 0 ? ref : ref.slice(0, hash)
  const frag = hash < 0 ? '' : ref.slice(hash)
  const baseNoFrag = base.replace(/#.*$/, '')
  if ('' === refPath) return baseNoFrag + frag
  return baseNoFrag.replace(/[^/]*$/, '') + refPath + frag
}

// ---- the resolver a host (the openapi plugin) would supply -----------
const ids = new Map()       // absolute $id/$self -> path of the resource
function indexIds(node, path, base) {
  if (Array.isArray(node)) return node.forEach((v, i) => indexIds(v, [...path, String(i)], base))
  if (!isRecord(node)) return
  const id = 'string' === typeof node.$self ? node.$self : 'string' === typeof node.$id ? node.$id : null
  if (id) { base = resolveUri(base, id); ids.set(base, path) }
  if ('string' === typeof node.$anchor) ids.set(base + '#' + node.$anchor, path)
  for (const k of Object.keys(node)) indexIds(node[k], [...path, k], base)
}

function pointerParts(frag) {
  let pointer
  try { pointer = decodeURIComponent(frag) } catch (_e) { return null }
  if ('' === pointer) return []
  if (!pointer.startsWith('/')) return null
  return pointer.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
}

const unresolved = []
function resolveRef(site, op, terms) {
  const [uri, siblings] = terms
  const abs = resolveUri(site.env.base || '', uri)
  const hash = abs.indexOf('#')
  const doc = hash < 0 ? abs : abs.slice(0, hash)
  const frag = hash < 0 ? '' : abs.slice(hash + 1)

  // Which resource? The entry document, or a `$id` in it.
  let start = []
  if ('' !== doc && doc !== (site.root.$self || '')) {
    if (!ids.has(doc)) { unresolved.push({ uri, abs, why: 'no such document or $id' }); return { $ref: uri, ...siblings } }
    start = ids.get(doc)
  }
  let parts
  if (frag.startsWith('/') || '' === frag) parts = [...start, ...pointerParts(frag)]
  else if (ids.has(doc + '#' + frag)) parts = ids.get(doc + '#' + frag)         // $anchor
  else { unresolved.push({ uri, abs, why: 'no such anchor' }); return { $ref: uri, ...siblings } }

  if (site.active.has(abs)) return { $ref: uri, ...siblings, cycle: true }
  site.active.add(abs)
  let node = site.root
  for (const part of parts) {
    if (isStructOp(node)) node = site.walk(node, parts, site.env)
    node = Array.isArray(node) ? node[Number(part)] : isRecord(node) ? node[part] : undefined
    if (undefined === node) break
  }
  let out
  if (undefined === node) { unresolved.push({ uri, abs, why: 'names nothing' }); out = { $ref: uri, ...siblings } }
  else if (site.walking.has(node)) out = { $ref: uri, ...siblings, cycle: true }
  else {
    const hit = site.walk(node, parts, site.env)
    const kind = /(^|\/)(schemas\/[^/]+|schema|items|properties\/[^/]+|allOf\/\d+|oneOf\/\d+|anyOf\/\d+|not|\$defs\/[^/]+)$/.test(site.path.join('/')) ? 'schema' : 'reference'
    if (!isRecord(hit)) out = hit
    else if ('schema' === kind) { const { allOf = [], ...rest } = siblings; out = 0 === Object.keys(siblings).length ? hit : { allOf: [hit, ...allOf], ...rest } }
    else { out = { ...hit }; for (const k of ['summary', 'description']) if (k in siblings) out[k] = siblings[k] }
  }
  site.active.delete(abs)
  return out
}

const isDataSlot = (keys) => keys.some((k, i) => k.startsWith('x-') || 'example' === k || 'enum' === k || 'const' === k || ('value' === k && 'examples' === keys[i - 2]))

const yamlSrc = `
openapi: 3.2.0
$self: https://api.example.com/openapi.yaml
paths:
  /pets:
    get:
      responses:
        '200': { $ref: '#/components/responses/PetList', description: Overridden }
        '404': { $ref: 'openapi.yaml#/components/responses/NotFound' }
components:
  responses:
    PetList: { description: A page of pets, content: { application/json: { schema: { $ref: 'https://schemas.example.com/pet.json' } } } }
    NotFound: { description: Not found }
  schemas:
    Pet:
      $id: https://schemas.example.com/pet.json
      type: object
      properties:
        name: { $ref: '#name' }
        tag: { $ref: 'tag.json', description: The tag }
        friends: { type: array, items: { $ref: '#' } }
      $defs:
        Name: { $anchor: name, type: string }
    Tag:
      $id: https://schemas.example.com/tag.json
      type: string
x-vendor: { $ref: '#/components/schemas/Tag' }
`

console.log('\n(b) a structural-operator layer over expr, with an inherited base URI')
const raw = new Tabnas().use(jsonic).use(Yaml).parse(yamlSrc)
indexIds(raw, [], raw.$self || '')
show('    $id/$self/$anchor index:', Object.fromEntries([...ids].map(([k, v]) => [k, v.join('/')])))

const tn = new Tabnas().use(jsonic).use(Yaml).use(ExprStruct, {
  op: { ref: { struct: true, key: '$ref' } },
  guard: (keys) => !isDataSlot(keys),
  evaluate: { when: 'end', fn: resolveRef, env: { base: raw.$self || '' } },
})
const res = tn.parse(yamlSrc)
show('    /pets 200 (Reference Object, description override) =', res.paths['/pets'].get.responses['200'])
show('    /pets 404 ($self-relative document reference) =', res.paths['/pets'].get.responses['404'])
show('    PetList schema (absolute $id of a schema in this document) =', res.components.responses.PetList.content['application/json'].schema)
show('    Pet.properties.name (`#name`: $anchor in the $id scope) =', res.components.schemas.Pet.properties.name)
show('    Pet.properties.tag (`tag.json` relative to the $id, Schema Object conjunction) =', res.components.schemas.Pet.properties.tag)
show('    Pet.properties.friends.items (`#` = this resource: cycle) =', res.components.schemas.Pet.properties.friends.items)
show('    x-vendor (data: verbatim) =', res['x-vendor'])
show('    unresolved =', unresolved)
console.log('    serialises:', 'string' === typeof JSON.stringify(res))

// The same document, operator tree only (no evaluate): expr's simplify
// reads the structural nodes as it reads token operators.
const ops = new Tabnas().use(jsonic).use(Yaml).use(ExprStruct, { op: { ref: { struct: true, key: '$ref' } }, guard: (keys) => !isDataSlot(keys) }).parse(yamlSrc)
show('    simplify(ops) /pets 200 =', simplify(ops).paths['/pets'].get.responses['200'])
show('    simplify(ops) x-vendor =', simplify(ops)['x-vendor'])

// ---------------------------------------------------------------- (c)
console.log('\n(c) what expr\'s own fold does with the same operator tree')
const viaExpr = evaluation(null, null, ops, () => 'RESOLVED')
console.log('    evaluation(root): /pets 200 still an op node:', isStructOp(viaExpr.paths['/pets'].get.responses['200']),
  '| on the node itself:', JSON.stringify(evaluation(null, null, ops.paths['/pets'].get.responses['200'], () => 'RESOLVED')))
