// E3: `$ref` as an expr-style OPERATOR NODE, resolved by a post-parse fold.
//
// `OpenApiMeta` layers on any JSON-family tabnas grammar (strict json,
// jsonic, jsonic+yaml). In `ops` mode it rewrites each map carrying a
// `$ref` key into an expr op node `[refOp, target, siblings]`, marked with
// expr's OP_MARK so expr's `simplify` and `evaluation` recognise it. In
// `resolve` mode it also folds the finished tree at the root rule's
// after-close, so `parse()` returns the resolved document.
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Yaml } = require('@tabnas/yaml')
const { json } = require('@tabnas/json')
const { evaluation, simplify, testing } = require('@tabnas/expr')

// `testing.opify` is the only way a host can mint an op that expr
// recognises (OP_MARK is module-private) and is documented as "not part of
// the stable API". Go exports `Opify` and Rust `opify` publicly.
const REF_OP = testing.opify({
  name: 'ref-meta', src: '$ref', terms: 2,
  prefix: false, infix: false, suffix: false, ternary: false, paren: false,
  left: Number.MIN_SAFE_INTEGER, right: Number.MAX_SAFE_INTEGER,
  use: { kind: 'reference' }, tkn: '', tin: -1, osrc: '', csrc: '',
  otkn: '', otin: -1, ctkn: '', ctin: -1, preval: { active: false, required: false },
})
const isRecord = (v) => null != v && 'object' === typeof v && !Array.isArray(v)
const isRefOp = (v) => Array.isArray(v) && null != v[0] && 'ref-meta' === v[0].name
const toOp = (n, token) => {
  const sib = {}
  for (const k of Object.keys(n)) if ('$ref' !== k) sib[k] = n[k]
  return [{ ...REF_OP, token }, n.$ref, sib]
}

// Grammar-neutral lift, for the maps no `val` close sees (below).
function lift(node) {
  if (isRefOp(node)) return node
  if (Array.isArray(node)) return node.map(lift)
  if (isRecord(node)) {
    const out = {}
    for (const k of Object.keys(node)) out[k] = '$ref' === k ? node[k] : lift(node[k])
    return 'string' === typeof out.$ref ? toOp(out, undefined) : out
  }
  return node
}

const OpenApiMeta = (tn, opts) => {
  const mode = opts.mode || 'raw'
  if ('raw' === mode) return                 // the document, verbatim
  tn.rule('val', (rs) => rs.ac((r) => {
    const n = r.node
    // Every value coalesces in `val`... except a mapping that starts a
    // YAML block-sequence entry (`- $ref: x`), which yaml's own
    // yamlElemMap/yamlElemPair rules build and push without a `val`.
    if (isRecord(n) && 'string' === typeof n.$ref) r.node = toOp(n, r.o0)
  }))
  // The START rule's after-close is the de facto end-of-parse hook. The
  // engine has `parse.prepare` hooks but no `finish`, and which rule is
  // the root is the grammar's choice: `val` for json and jsonic, `stream`
  // for yaml. Reading rule.start at install time depends on install order.
  if ('resolve' === mode) {
    const start = tn.options.rule.start
    tn.rule(start, (rs) => rs.ac((r) => {
      if (0 !== r.d) return
      const out = makeResolver(lift(r.node), opts.marker || '__info__')
      r.node = out.resolve()
      if (opts.unresolved) opts.unresolved.push(...out.unresolved)
    }))
  }
}

// ---- resolution --------------------------------------------------------
function pointerParts(frag) {
  if ('' === frag) return []
  if (!frag.startsWith('/')) return null
  return frag.slice(1).split('/').map((p) =>
    decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
}

// Which OpenAPI object a site is: decides what `$ref` siblings mean.
//   Reference Object: only summary/description survive, as overrides.
//   Schema Object:    every sibling keyword applies (2020-12), so the
//                     honest resolved form is a conjunction, spelt allOf.
//   Path Item:        adjacent fields: behaviour undefined; keep site keys.
function siteKind(path) {
  const p = path.join('/')
  if (/(^|\/)(schemas\/[^/]+|schema|items|properties\/[^/]+|additionalProperties|allOf\/\d+|oneOf\/\d+|anyOf\/\d+|not|prefixItems\/\d+|\$defs\/[^/]+)$/.test(p)) return 'schema'
  if (/^paths\/[^/]+$/.test(p) || /^components\/pathItems\/[^/]+$/.test(p)) return 'pathItem'
  return 'reference'
}

function makeResolver(root, marker) {
  const memo = new Map()     // source node -> resolved value (shared)
  const active = new Set()   // refs on the current chain: a repeat is a cycle
  const unresolved = []

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
      else if (isRecord(node)) node = Object.prototype.hasOwnProperty.call(node, part) ? node[part] : undefined
      else node = undefined
      path = [...path, part]
      if (undefined === node) return { why: 'names nothing' }
    }
    return { node, path }
  }

  // The value an op node stands for, with its target walked first so a
  // ref inside the target is resolved too and every site naming one
  // target shares one result. A cycle keeps the back edge verbatim.
  function deref(node, path) {
    if (memo.has(node)) return memo.get(node)
    const [op, uri, sib] = node
    const siblings = walk(sib, path)
    let out
    if (active.has(uri)) {
      out = { $ref: uri, ...siblings }
      Object.defineProperty(out, marker, { value: { ref: uri, cycle: true }, writable: true })
      return out                                   // not memoised: a back edge, not a value
    }
    active.add(uri)
    const found = locate(uri)
    const hit = undefined === found.node ? undefined : walk(found.node, found.path)
    active.delete(uri)
    if (undefined === hit) {
      unresolved.push({ uri, why: found.why })
      out = { $ref: uri, ...siblings }
    }
    else if (!isRecord(hit)) out = hit
    else switch (siteKind(path)) {
      case 'schema': {
        const keys = Object.keys(siblings)
        out = 0 === keys.length ? hit : { allOf: [hit], ...siblings }
        break
      }
      case 'reference': {
        out = { ...hit }
        for (const k of ['summary', 'description']) if (k in siblings) out[k] = siblings[k]
        break
      }
      default: out = { ...hit, ...siblings }
    }
    if (isRecord(out) && !Object.prototype.hasOwnProperty.call(out, marker)) {
      Object.defineProperty(out, marker, {
        value: { ref: uri, kind: siteKind(path), at: op.token ? { line: op.token.rI, col: op.token.cI } : undefined },
        writable: true })
    }
    memo.set(node, out)
    return out
  }

  // expr's `evaluation` folds op nodes and arrays, NOT objects: walk the
  // objects here and hand each op node to `evaluation`, with the path.
  function walk(node, path) {
    if (memo.has(node)) return memo.get(node)
    if (isRefOp(node)) {
      return evaluation(null, null, node, (_r, _c, op, terms) => deref([op, terms[0], terms[1]], path))
    }
    if (Array.isArray(node)) {
      const out = node.map((v, i) => walk(v, [...path, String(i)]))
      memo.set(node, out)
      return out
    }
    if (isRecord(node)) {
      const out = {}
      memo.set(node, out)
      for (const k of Object.keys(node)) out[k] = walk(node[k], [...path, k])
      return out
    }
    return node
  }
  return { resolve: () => walk(root, []), unresolved }
}

// ---- the document, in YAML (components AFTER paths, as usual) ----------
const yamlSrc = `
openapi: 3.2.0
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
`
const jsonSrc = JSON.stringify(new Tabnas().use(jsonic).use(Yaml).parse(yamlSrc), null, 2)
const show = (label, v) => console.log(label, JSON.stringify(v))
const countOps = (n) => isRefOp(n) ? 1 : Array.isArray(n) ? n.reduce((a, v) => a + countOps(v), 0)
  : isRecord(n) ? Object.values(n).reduce((a, v) => a + countOps(v), 0) : 0
const countRefs = (n) => isRecord(n) && 'string' === typeof n.$ref ? 1 : Array.isArray(n) ? n.reduce((a, v) => a + countRefs(v), 0)
  : isRecord(n) ? Object.values(n).reduce((a, v) => a + countRefs(v), 0) : 0

const Y = (opts) => new Tabnas().use(jsonic).use(Yaml).use(OpenApiMeta, opts)
const J = (opts) => new Tabnas().use(json).use(OpenApiMeta, opts)

// 1. raw mode is verbatim, from YAML and from pretty-printed JSON.
const rawY = Y({ mode: 'raw' }).parse(yamlSrc), rawJ = J({ mode: 'raw' }).parse(jsonSrc)
console.log('1. raw: yaml == json == JSON.parse:', JSON.stringify(rawY) === JSON.stringify(rawJ), JSON.stringify(rawJ) === JSON.stringify(JSON.parse(jsonSrc)),
  '; also via jsonic+Yaml on the JSON text:', JSON.stringify(Y({ mode: 'raw' }).parse(jsonSrc)) === JSON.stringify(rawJ))

// 2. ops mode: how many of the 8 $ref maps did the `val` hook catch?
const opsY = Y({ mode: 'ops' }).parse(yamlSrc), opsJ = J({ mode: 'ops' }).parse(jsonSrc)
console.log(`2. ops: $ref maps in document: ${countRefs(rawY)}; op nodes built at parse time: yaml ${countOps(opsY)} (missed ${countRefs(opsY)}: the block-sequence entry), json ${countOps(opsJ)}`)
show('   simplify(/pets 200) =', simplify(opsY).paths['/pets'].get.responses['200'])
show('   simplify(parameters) =', simplify(opsY).paths['/pets'].get.parameters, '<- yaml: still a map')
show('   simplify(parameters) =', simplify(opsJ).paths['/pets'].get.parameters, '<- json: an op')
console.log('   JSON.stringify(op node) is the op-array, not the document:', JSON.stringify(opsJ.paths['/pets'].get.parameters[0], (k, v) => 'token' === k || 'OP_MARK' === k ? undefined : v).slice(0, 60) + '...')
console.log('   simplify(ops) yaml == json after lift():', JSON.stringify(simplify(lift(opsY))) === JSON.stringify(simplify(lift(opsJ))))

// 3. resolve mode: parse() returns the resolved document.
const unresolved = []
const res = Y({ mode: 'resolve', unresolved }).parse(yamlSrc)
const resJ = J({ mode: 'resolve' }).parse(jsonSrc)
console.log('3. resolved yaml == resolved json:', JSON.stringify(res) === JSON.stringify(resJ), '; JSON.stringify is finite:', 'string' === typeof JSON.stringify(res))
show('   /pets 200 (Reference Object: description overrides) =', res.paths['/pets'].get.responses['200'])
show('   /pets 404 (ref -> ref) =', res.paths['/pets'].get.responses['404'])
show('   /pets/{id} 200 (~1 pointer into paths) =', res.paths['/pets/{id}'].get.responses['200'])
show('   parameters[0] =', res.paths['/pets'].get.parameters[0])
show('   provenance (hidden) =', res.paths['/pets'].get.parameters[0].__info__)
show('   Pet.friends.items (cycle: back edge kept) =', res.components.schemas.Pet.properties.friends.items)
show('   Pet.tag (Schema Object: sibling is a conjunction) =', res.components.schemas.Pet.properties.tag)
show('   Pet.owner (external, verbatim) =', res.components.schemas.Pet.properties.owner)
show('   unresolved =', unresolved)
console.log('   one target, one object: /pets 200 content === PetList content:', res.paths['/pets'].get.responses['200'].content === res.components.responses.PetList.content)
console.log('   /pets/{id} 200 === /pets 200:', res.paths['/pets/{id}'].get.responses['200'] === res.paths['/pets'].get.responses['200'])

// 4. evaluation() alone, on the whole tree, does nothing to the maps.
const viaEvaluation = evaluation(null, null, opsJ, () => 'X')
console.log('4. evaluation(root) leaves ops inside maps:', isRefOp(viaEvaluation.paths['/pets'].get.responses['200']),
  '; reduces a LIST of ops:', JSON.stringify(evaluation(null, null, opsJ.paths['/pets'].get.parameters, () => 'X')))
