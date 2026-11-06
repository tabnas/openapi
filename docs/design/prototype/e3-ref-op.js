// E3: `$ref` as an expr-style OPERATOR NODE, resolved by a post-parse fold.
//
// `OpenApiMeta` layers on any JSON-family tabnas grammar (strict json,
// jsonic, jsonic+yaml). In `ops` mode it rewrites each map carrying a
// `$ref` key into an expr op node `[refOp, target, siblings]`, marked with
// expr's OP_MARK so expr's `simplify` and `evaluation` recognise it. In
// `resolve` mode it folds the finished tree when the parse completes and
// hands the result back through `ctx.root().node`. The fold is also
// exported as `resolve(raw, opts)` for a host that parses first and
// resolves later, which is how apidef's pipeline is shaped.
//
// Third revision. The second review found: the start rule's after-close
// is not an end-of-parse hook (yaml's `stream` rule is replaced on
// directives and document markers, and parse() returns the ORIGINAL root
// rule's node); plugin options are deep-copied by `use()`, so a mutable
// array handed in through them never reaches the caller; a `$ref` sibling
// rule has to know the document VERSION (3.0.x has no Schema Object
// conjunction, Swagger 2.0 is JSON Reference everywhere); writes with
// `out[k] = v` drop a `__proto__` key. Each is addressed below and has a
// case in the output.
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { json } = require('@tabnas/json')
const { evaluation, simplify, testing } = require('@tabnas/expr')

const REF_OP = testing.opify({
  name: 'ref-meta', src: '$ref', terms: 2,
  prefix: false, infix: false, suffix: false, ternary: false, paren: false,
  left: Number.MIN_SAFE_INTEGER, right: Number.MAX_SAFE_INTEGER,
  use: { kind: 'reference' }, tkn: '', tin: -1, osrc: '', csrc: '',
  otkn: '', otin: -1, ctkn: '', ctin: -1, preval: { active: false, required: false },
})
const isRecord = (v) => null != v && 'object' === typeof v && !Array.isArray(v)
const isRefOp = (v) => Array.isArray(v) && null != v[0] && 'ref-meta' === v[0].name
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// Null-prototype containers with defined (not assigned) members, so a key
// named `__proto__` stays data on the way through, as the raw tree keeps it.
const record = () => Object.create(null)
const put = (o, k, v) => (Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }), o)
const copy = (...srcs) => { const o = record(); for (const s of srcs) for (const k of Object.keys(s)) put(o, k, s[k]); return o }

const toOp = (n, token) => {
  const sib = record()
  for (const k of Object.keys(n)) if ('$ref' !== k) put(sib, k, n[k])
  return [{ ...REF_OP, token }, n.$ref, sib]
}

// ---- which document, which slot ----------------------------------------
// The version decides what a `$ref` means. Swagger 2.0: JSON Reference,
// siblings ignored everywhere, targets under #/definitions etc. 3.0.x: a
// Reference Object wherever it stands, siblings ignored, no $id/$anchor.
// 3.1 and later: Reference Object (summary/description override) except a
// Schema Object, where $ref is a JSON Schema keyword and siblings apply.
function docVersion(root) {
  if (!isRecord(root)) return 'unknown'
  if (null != root.swagger) return '2.0'                      // `swagger: 2.0` unquoted reads as the number 2
  const v = String(root.openapi || '')
  if (v.startsWith('3.0')) return '3.0'
  if (v.startsWith('3.')) return '3.1+'
  return 'unknown'
}

// Slots whose content is data, where a `$ref` key is a literal. A real
// plugin derives this, and the schema/pathItem kinds below, from the full
// object model of the version in hand; these keyword tests approximate it.
function isDataSlot(path) {
  for (let i = 0; i < path.length; i++) {
    const k = path[i]
    if (k.startsWith('x-')) return true
    if ('example' === k || 'const' === k || 'enum' === k) return true
    if ('default' === k && 'responses' !== path[i - 1]) return true
    if ('value' === k && 'examples' === path[i - 2]) return true
    if (('dataValue' === k || 'serializedValue' === k) && 'examples' === path[i - 2]) return true
  }
  return false
}
const SCHEMA_TAIL = /(^|\/)(schemas\/[^/]+|definitions\/[^/]+|schema|items|additionalProperties|additionalItems|contains|propertyNames|not|if|then|else|contentSchema|unevaluatedItems|unevaluatedProperties|properties\/[^/]+|patternProperties\/[^/]+|dependentSchemas\/[^/]+|\$defs\/[^/]+|(allOf|oneOf|anyOf|prefixItems)\/\d+)$/
function siteKind(path) {
  const p = path.join('/')
  if (SCHEMA_TAIL.test(p)) return 'schema'
  if (/^paths\/[^/]+$/.test(p) || /^webhooks\/[^/]+$/.test(p) || /^components\/pathItems\/[^/]+$/.test(p)) return 'pathItem'
  return 'reference'
}

// The keys from the root to a rule, read off the rule stack.
function ancestorKeys(r, ctx) {
  const keys = []
  for (let p = r.parent; p && p !== ctx.NORULE; p = p.parent) {
    if (('pair' === p.name || 'yamlElemPair' === p.name) && undefined !== p.u.key) keys.unshift(String(p.u.key))
    else if ('elem' === p.name || 'yamlBlockElem' === p.name) keys.unshift('*')
  }
  return keys
}

// Grammar-neutral lift of the maps no `val` close saw.
function lift(node, path = []) {
  if (isRefOp(node) || isDataSlot(path)) return node
  if (Array.isArray(node)) return node.map((v, i) => lift(v, [...path, String(i)]))
  if (isRecord(node)) {
    const out = record()
    for (const k of Object.keys(node)) put(out, k, '$ref' === k ? node[k] : lift(node[k], [...path, k]))
    return 'string' === typeof out.$ref ? toOp(out, undefined) : out
  }
  return node
}

// ---- the plugin ---------------------------------------------------------
const OpenApiMeta = (tn, opts) => {
  const mode = opts.mode || 'raw'
  if ('raw' === mode) return
  tn.rule('val', (rs) => rs.ac((r, ctx) => {
    const n = r.node
    if (isRecord(n) && 'string' === typeof n.$ref && !isDataSlot(ancestorKeys(r, ctx))) r.node = toOp(n, r.o0)
  }))
  if ('resolve' === mode) {
    // End of parse, grammar-neutrally: the engine's post-process rule
    // subscriber fires after every pass; the LAST pass of a parse is a
    // depth-0 close whose alternate neither pushes nor replaces, outside
    // any probe and not synthesised by recovery. The start rule's own
    // after-close is NOT that: yaml replaces `stream` on `%YAML`, `---`
    // and `...`, and parse() returns the original root rule's node.
    tn.sub({ ruleDone: (r, ctx, done) => {
      if (0 !== r.d || 'c' !== done.state || !done.alt || done.alt.p || done.alt.r || done.probe || done.forced) return
      const out = resolve(ctx.root().node, opts)
      ctx.root().node = out.tree
      // Plugin options are deep-copied by use(), so an array passed in
      // never reaches the caller; a function does (copied by reference).
      if ('function' === typeof opts.onResolved) opts.onResolved(out)
    } })
  }
}

// ---- resolution --------------------------------------------------------
// RFC 6901 section 6: percent-decode the whole fragment, then split, then
// undo `~1` `~0` per token.
function pointerParts(frag) {
  let pointer
  try { pointer = decodeURIComponent(frag) } catch (_e) { return null }
  if ('' === pointer) return []
  if (!pointer.startsWith('/')) return null
  return pointer.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
}

// `resolve(raw, opts)`: the exported entry point. Returns
// { tree, unresolved, provenance, cuts, version }. `tree` is a DAG: one
// object per target, shared by every site naming it. A cycle is cut to the
// verbatim `{ $ref }` by default (`cycle: 'cut'`) and recorded in `cuts`
// (holder path, key, target path) so a consumer can read through it;
// `cycle: 'keep'` leaves the object graph cyclic. `provenance` is a side
// table keyed by path, not a marker on the nodes, so Go and Rust can carry
// it without changing node types.
function resolve(rawTree, opts = {}) {
  const root = lift(rawTree)
  const version = opts.version || docVersion(rawTree)
  const cycle = opts.cycle || 'cut'
  const memo = new Map()     // source node -> resolved value (shared)
  const active = new Set()   // ref URIs on the current chain
  const walking = new Set()  // source nodes whose value is still being built
  const unresolved = [], provenance = [], cuts = []

  function locate(uri) {
    const hash = uri.indexOf('#')
    const doc = hash < 0 ? uri : uri.slice(0, hash)
    const frag = hash < 0 ? '' : uri.slice(hash + 1)
    if ('' !== doc) return { why: 'external document' }
    const parts = pointerParts(frag)
    if (null == parts) return { why: 'fragment is not a JSON pointer' }
    let node = root, path = []
    for (const part of parts) {
      node = isRefOp(node) ? deref(node, path) : node
      if (Array.isArray(node)) node = /^(0|[1-9]\d*)$/.test(part) ? node[Number(part)] : undefined
      else if (isRecord(node)) node = own(node, part) ? node[part] : undefined
      else node = undefined
      path = [...path, part]
      if (undefined === node) return { why: 'names nothing' }
    }
    return { node, path }
  }

  function backEdge(uri, siblings, path, targetPath) {
    cuts.push({ at: path.join('/'), ref: uri, target: targetPath ? targetPath.join('/') : undefined })
    return copy({ $ref: uri }, siblings)
  }

  // What `$ref` plus siblings mean, by version and by the object at the site.
  function combine(hit, siblings, kind) {
    const keys = Object.keys(siblings)
    if (!isRecord(hit) || 0 === keys.length) return hit
    if ('2.0' === version) return hit                                   // JSON Reference: siblings ignored
    if ('pathItem' === kind) return copy(hit, siblings)                 // adjacent fields: undefined; keep both
    if ('schema' === kind && '3.1+' === version) {                      // 2020-12: a conjunction
      const { allOf = [], ...rest } = siblings
      return copy({ allOf: [hit, ...allOf] }, rest)
    }
    const out = copy(hit)                                               // Reference Object (3.0 schema included)
    if ('3.0' !== version) for (const k of ['summary', 'description']) if (own(siblings, k)) put(out, k, siblings[k])
    return out
  }

  function deref(node, path) {
    if (memo.has(node)) return memo.get(node)
    const [op, uri, sib] = node
    const siblings = walk(sib, path)
    if (active.has(uri)) return backEdge(uri, siblings, path)
    active.add(uri)
    const found = locate(uri)
    let out
    if (undefined !== found.node && walking.has(found.node)) {
      out = 'keep' === cycle ? memo.get(found.node) : backEdge(uri, siblings, path, found.path)
    }
    else {
      const hit = undefined === found.node ? undefined : walk(found.node, found.path)
      if (undefined === hit) { unresolved.push({ at: path.join('/'), ref: uri, why: found.why }); out = copy({ $ref: uri }, siblings) }
      else out = combine(hit, siblings, siteKind(path))
    }
    active.delete(uri)
    if (undefined !== found.node) provenance.push({ at: path.join('/'), ref: uri, kind: siteKind(path), line: op.token ? op.token.rI : undefined, col: op.token ? op.token.cI : undefined })
    memo.set(node, out)
    return out
  }

  function walk(node, path) {
    if (memo.has(node)) return memo.get(node)
    if (isRefOp(node)) return evaluation(null, null, node, (_r, _c, op, terms) => deref([op, terms[0], terms[1]], path))
    if (Array.isArray(node)) {
      const out = []
      memo.set(node, out); walking.add(node)
      for (let i = 0; i < node.length; i++) out.push(walk(node[i], [...path, String(i)]))
      walking.delete(node)
      return out
    }
    if (isRecord(node)) {
      const out = record()
      memo.set(node, out); walking.add(node)
      for (const k of Object.keys(node)) put(out, k, walk(node[k], [...path, k]))
      walking.delete(node)
      return out
    }
    return node
  }
  return { tree: walk(root, []), unresolved, provenance, cuts, version }
}

module.exports = { OpenApiMeta, resolve, lift, isRefOp, REF_OP }
if (require.main !== module) return

// ---- the document, in YAML (components AFTER paths, as usual) ----------
const yamlSrc = `
openapi: 3.1.0
info: { title: Pets, version: "1" }
paths:
  /pets:
    get:
      parameters:
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          $ref: '#/components/responses/PetList'
          description: Overrides the component description
        '404':
          $ref: '#/components/responses/Missing'
  /pets/{id}:
    get:
      responses:
        '200':
          $ref: '#/paths/~1pets/get/responses/200'
components:
  parameters:
    Limit: { name: limit, in: query, schema: { type: integer } }
  responses:
    PetList:
      description: A page of pets
      content:
        application/json:
          schema: { type: array, items: { $ref: '#/components/schemas/Pet' } }
          example: { $ref: '#/components/schemas/Pet', note: data }
    Missing: { $ref: '#/components/responses/NotFound' }
    NotFound: { description: Not found }
  schemas:
    Pet:
      type: object
      properties:
        name: { type: string }
        friends: { type: array, items: { $ref: '#/components/schemas/Pet' } }
        owner: { $ref: 'https://example.com/schemas/person.json' }
        tag: { $ref: '#/components/schemas/Tag', description: The pet's tag }
    Tag: { type: string }
    Derived: { $ref: '#/components/schemas/Tag', allOf: [{ maxLength: 5 }] }
    Node:
      type: object
      properties:
        child: { $ref: '#/components/schemas/Node' }
    Encoded: { $ref: '#/components%2Fschemas/Tag' }
    __proto__: { type: string, description: a key named __proto__ is data }
x-vendor: { $ref: '#/components/schemas/Tag', keep: literal }
`
const jsonSrc = JSON.stringify(new Tabnas().use(jsonic).use(Yaml).parse(yamlSrc), null, 2)
const show = (label, v, note) => console.log(label, JSON.stringify(v) + (note ? ' ' + note : ''))
const countOps = (n) => isRefOp(n) ? 1 : Array.isArray(n) ? n.reduce((a, v) => a + countOps(v), 0)
  : isRecord(n) ? Object.values(n).reduce((a, v) => a + countOps(v), 0) : 0
const countRefs = (n) => isRecord(n) && 'string' === typeof n.$ref ? 1 : Array.isArray(n) ? n.reduce((a, v) => a + countRefs(v), 0)
  : isRecord(n) ? Object.values(n).reduce((a, v) => a + countRefs(v), 0) : 0

const Y = (opts) => new Tabnas().use(jsonic).use(Yaml).use(OpenApiMeta, opts)
const J = (opts) => new Tabnas().use(json).use(OpenApiMeta, opts)

// 1. raw mode is verbatim, from YAML and from pretty-printed JSON.
const rawY = Y({ mode: 'raw' }).parse(yamlSrc), rawJ = J({ mode: 'raw' }).parse(jsonSrc)
console.log('1. raw: yaml == json == JSON.parse (as JSON text):', JSON.stringify(rawY) === JSON.stringify(rawJ), JSON.stringify(rawJ) === JSON.stringify(JSON.parse(jsonSrc)),
  '; also via jsonic+Yaml on the JSON text:', JSON.stringify(Y({ mode: 'raw' }).parse(jsonSrc)) === JSON.stringify(rawJ))
console.log('   containers have a null prototype:', null === Object.getPrototypeOf(rawY), '; __proto__ is an own key of components.schemas:', Object.keys(rawY.components.schemas).includes('__proto__'))

// 2. ops mode.
const opsY = Y({ mode: 'ops' }).parse(yamlSrc), opsJ = J({ mode: 'ops' }).parse(jsonSrc)
console.log(`2. ops: $ref maps in document: ${countRefs(rawY)} (2 of them data: an x- extension and an example payload); op nodes built at parse time: yaml ${countOps(opsY)} (missed ${countRefs(opsY) - 2}: the block-sequence entry), json ${countOps(opsJ)}`)
show('   simplify(/pets 200) =', simplify(opsY).paths['/pets'].get.responses['200'])
show('   simplify(parameters) =', simplify(opsY).paths['/pets'].get.parameters, '<- yaml: still a map')
show('   simplify(parameters) =', simplify(opsJ).paths['/pets'].get.parameters, '<- json: an op')
console.log('   simplify(ops) yaml == json after lift():', JSON.stringify(simplify(lift(opsY))) === JSON.stringify(simplify(lift(opsJ))))

// 3. resolve mode: parse() returns the resolved document; the report
//    arrives through the callback.
let report
const res = Y({ mode: 'resolve', onResolved: (out) => { report = out } }).parse(yamlSrc)
const resJ = J({ mode: 'resolve' }).parse(jsonSrc)
console.log('3. resolved yaml == resolved json:', JSON.stringify(res) === JSON.stringify(resJ), '; JSON.stringify is finite:', 'string' === typeof JSON.stringify(res), '; version:', report.version)
show('   /pets 200 (Reference Object: description overrides) =', res.paths['/pets'].get.responses['200'])
show('   /pets 404 (ref -> ref) =', res.paths['/pets'].get.responses['404'])
show('   /pets/{id} 200 (~1 pointer into paths) =', res.paths['/pets/{id}'].get.responses['200'])
show('   parameters[0] =', res.paths['/pets'].get.parameters[0])
show('   Pet.friends.items (cycle: back edge kept) =', res.components.schemas.Pet.properties.friends.items)
show('   Pet.tag (Schema Object, 3.1: sibling is a conjunction) =', res.components.schemas.Pet.properties.tag)
show('   Pet.owner (external, verbatim) =', res.components.schemas.Pet.properties.owner)
show('   Derived (site allOf joins the target) =', res.components.schemas.Derived)
show('   Node.properties.child (recursion met top-down) =', res.components.schemas.Node.properties.child)
show('   Encoded (%2F is a separator) =', res.components.schemas.Encoded)
show('   x-vendor (extension: data, verbatim) =', res['x-vendor'])
show('   PetList example (payload: data, verbatim) =', res.components.responses.PetList.content['application/json'].example)
console.log('   __proto__ survives as an own key:', Object.keys(res.components.schemas).includes('__proto__'))
show('   unresolved =', report.unresolved)
show('   cuts =', report.cuts)
show('   provenance[0..2] =', report.provenance.slice(0, 3))
console.log('   one target, one object: /pets 200 content === PetList content:', res.paths['/pets'].get.responses['200'].content === res.components.responses.PetList.content)
console.log('   /pets/{id} 200 === /pets 200:', res.paths['/pets/{id}'].get.responses['200'] === res.paths['/pets'].get.responses['200'], '(a Reference Object with overriding siblings is a copy of its target, by design)')

// 4. the version axis: the same sites under 3.0 and under Swagger 2.0.
const v30 = resolve(rawY ? Object.assign(Object.create(null), rawY, { openapi: '3.0.3' }) : rawY)
show('4. 3.0.3: Pet.tag (a Reference Object: siblings ignored) =', v30.tree.components.schemas.Pet.properties.tag)
show('   3.0.3: /pets 200 (siblings ignored too) =', v30.tree.paths['/pets'].get.responses['200'].description)
const v20 = resolve(Object.assign(Object.create(null), rawY, { openapi: undefined, swagger: 2 }))
show('   swagger 2 (unquoted 2.0 reads as the number 2): version =', v20.version, '; Derived =')
show('   ', v20.tree.components.schemas.Derived)

// 5. YAML directives and document markers: the start rule is replaced,
//    the ruleDone trigger still resolves exactly once.
for (const src of ['%YAML 1.2\n---\na: { $ref: "#/b" }\nb: 1\n', 'a: { $ref: "#/b" }\nb: 1\n...\n', '---\na: { $ref: "#/b" }\nb: 1\n']) {
  let n = 0
  const out = Y({ mode: 'resolve', onResolved: () => n++ }).parse(src)
  console.log('5. yaml', JSON.stringify(src.split('\n')[0]).padEnd(22), '-> resolved', JSON.stringify(out), '; trigger fired', n, 'time(s)')
}

// 6. expr's own fold on the whole tree does nothing to the maps.
console.log('6. evaluation(root) leaves ops inside maps:', isRefOp(evaluation(null, null, opsJ, () => 'X').paths['/pets'].get.responses['200']),
  '; reduces a LIST of ops:', JSON.stringify(evaluation(null, null, opsJ.paths['/pets'].get.parameters, () => 'X')))
