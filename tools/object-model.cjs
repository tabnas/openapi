#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/object-model.cjs: generate the OpenAPI object model.
//
// The object model says, for every position in a description of each
// version this package reads, what the position holds: an OpenAPI object
// of a named type, a slot that holds either a Reference Object or an
// object of a named type, a Schema Object, a list, a map, a locator (a
// URI reference that is resolved and checked but never substituted), an
// implicit connection (a name that names something elsewhere), or data.
// The resolver asks it what a `$ref` map is, and what a Reference Object
// stands for. An unknown position is data.
//
// It is generated, never hand-written, from three inputs, as the plan
// requires (docs/design/implementation-plan.md, Phase 2):
//
//   model/schemas/      the OpenAPI Initiative's dated validation schemas,
//                       vendored unchanged and pinned in sources.json by
//                       URL, date and SHA-256;
//   model/applicators.json
//                       which members of a Schema Object hold schemas, per
//                       schema dialect, which the validation schemas
//                       cannot say;
//   model/overlay.json  the positions the schemas type as plain strings or
//                       maps that the specification gives a meaning to,
//                       each with its reason.
//
// It writes model/object-model.json, the model every runtime embeds, and
// ts/src/object-model.ts, the TypeScript copy. `--check` writes nothing
// and fails when either file differs from what the inputs generate, which
// is how the test suite holds the committed copies to their inputs.
//
// Usage: node tools/object-model.cjs [--check]

const Fs = require('node:fs')
const Path = require('node:path')
const Crypto = require('node:crypto')

const ROOT = Path.join(__dirname, '..')
const MODEL = Path.join(ROOT, 'model')
const OUT_JSON = Path.join(MODEL, 'object-model.json')
const OUT_TS = Path.join(ROOT, 'ts', 'src', 'object-model.ts')

// What each version's schema calls things. `defs` is where its
// definitions live; `reference` the definitions that are the Reference
// Object; `schema` those that are the Schema Object; `types` the canonical
// type name of a definition whose name is not already it, a nested
// definition named by its path below `defs`; `external` the documents
// outside the vendored ones that the schema refers to, whose definitions
// are scalar keywords.
const VERSIONS = {
  '2.0': {
    dialect: 'draft-04',
    defs: 'definitions',
    external: ['http://json-schema.org/draft-04/schema'],
    reference: ['jsonReference'],
    schema: ['schema', 'fileSchema'],
    types: {
      bodyParameter: 'parameter',
      headerParameterSubSchema: 'parameter',
      queryParameterSubSchema: 'parameter',
      formDataParameterSubSchema: 'parameter',
      pathParameterSubSchema: 'parameter',
      nonBodyParameter: 'parameter',
      basicAuthenticationSecurity: 'securityScheme',
      apiKeySecurity: 'securityScheme',
      oauth2ImplicitSecurity: 'securityScheme',
      oauth2PasswordSecurity: 'securityScheme',
      oauth2ApplicationSecurity: 'securityScheme',
      oauth2AccessCodeSecurity: 'securityScheme',
      jsonReference: 'reference',
      primitivesItems: 'items',
    },
  },
  '3.0': {
    dialect: 'wright-00',
    defs: 'definitions',
    reference: ['Reference'],
    schema: ['Schema'],
    types: {
      XML: 'xml',
      ExternalDocumentation: 'externalDocs',
      PathParameter: 'parameter',
      QueryParameter: 'parameter',
      HeaderParameter: 'parameter',
      CookieParameter: 'parameter',
      APIKeySecurityScheme: 'securityScheme',
      HTTPSecurityScheme: 'securityScheme',
      OAuth2SecurityScheme: 'securityScheme',
      OpenIdConnectSecurityScheme: 'securityScheme',
      ImplicitOAuthFlow: 'oauthFlow',
      PasswordOAuthFlow: 'oauthFlow',
      ClientCredentialsFlow: 'oauthFlow',
      AuthorizationCodeOAuthFlow: 'oauthFlow',
      OAuthFlows: 'oauthFlows',
    },
  },
  '3.1': {
    dialect: '2020-12',
    defs: '$defs',
    reference: ['reference'],
    schema: ['schema'],
    types: {
      'external-documentation': 'externalDocs',
      'external-docs': 'externalDocs',
      callbacks: 'callback',
      'oauth-flows': 'oauthFlows',
      // Each flow is an OAuth Flow Object, as 3.0's four flow definitions are.
      'oauth-flows/$defs/implicit': 'oauthFlow',
      'oauth-flows/$defs/password': 'oauthFlow',
      'oauth-flows/$defs/client-credentials': 'oauthFlow',
      'oauth-flows/$defs/authorization-code': 'oauthFlow',
    },
  },
  '3.2': {
    dialect: '2020-12',
    defs: '$defs',
    reference: ['reference'],
    schema: ['schema'],
    types: {
      'external-documentation': 'externalDocs',
      'external-docs': 'externalDocs',
      callbacks: 'callback',
      'oauth-flows': 'oauthFlows',
      'oauth-flows/$defs/implicit': 'oauthFlow',
      'oauth-flows/$defs/password': 'oauthFlow',
      'oauth-flows/$defs/client-credentials': 'oauthFlow',
      'oauth-flows/$defs/authorization-code': 'oauthFlow',
      'oauth-flows/$defs/device-authorization': 'oauthFlow',
    },
  },
}

function fail(msg) {
  const err = new Error('object-model: ' + msg)
  err.objectModel = true
  throw err
}

function readJson(file) {
  return JSON.parse(Fs.readFileSync(file, 'utf8'))
}

// The vendored schemas, each checked against its pinned hash. `read`
// gives a file's bytes; tests pass their own.
function loadSources(read = (file) => Fs.readFileSync(Path.join(MODEL, 'schemas', file))) {
  const manifest = JSON.parse(read('sources.json').toString('utf8'))
  const byVersion = {}
  for (const src of manifest.sources) {
    const bytes = read(src.file)
    const hash = Crypto.createHash('sha256').update(bytes).digest('hex')
    if (hash !== src.sha256) {
      fail(`${src.file} does not match its pinned SHA-256 in sources.json`)
    }
    byVersion[src.version] ??= {}
    byVersion[src.version][src.role] = { url: src.url, doc: JSON.parse(bytes.toString('utf8')) }
  }
  return byVersion
}

// A canonical type name: camelCase, as the specification names the
// objects in prose, with the version's own exceptions. A nested
// definition goes by its own key, the last segment of its path.
function typeName(cfg, def) {
  if (Object.prototype.hasOwnProperty.call(cfg.types, def)) return cfg.types[def]
  const own = def.slice(def.lastIndexOf('/') + 1)
  const camel = own.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  return camel.charAt(0).toLowerCase() + camel.slice(1)
}

const STRUCTURE = [
  'properties', 'patternProperties', 'additionalProperties', 'items',
  'allOf', 'anyOf', 'oneOf', 'then', 'else', 'dependentSchemas',
]

// The pattern every version gives its extensions. An extension's value
// belongs to its author, whatever the schema allows it: data.
const EXTENSION = '^x-'

// A `$ref` with nothing beside it but annotations names another schema;
// a `$ref` beside structure is merged into it, as an allOf member is.
function onlyRef(node) {
  return (
    null != node && 'object' === typeof node && 'string' === typeof node.$ref &&
    !STRUCTURE.some((k) => k in node) && !('type' in node && 'object' !== node.type)
  )
}

function build(version, sources, applicators) {
  const cfg = VERSIONS[version]
  const main = sources[version].schema
  const meta = sources[version].meta
  const dialect = applicators.dialects[cfg.dialect]
  if (null == dialect) fail(`no applicator list for dialect ${cfg.dialect}`)

  const states = {}
  const memo = new Map()

  // A `$ref` of the version's schemas, followed. A JSON Pointer into the
  // document the node came from names a definition ('#/$defs/x',
  // '#/definitions/x') or one nested inside another (3.1's
  // '#/$defs/oauth-flows/$defs/implicit'), which goes by its path below
  // the definitions ('oauth-flows/$defs/implicit'). A reference into a
  // document the version declares `external` (draft-04's metaschema, in
  // 2.0) names a scalar keyword: data, so null. Any other reference is an
  // input the generator does not understand, and fails rather than read
  // as data.
  function deref(ref, src) {
    const hash = ref.indexOf('#')
    if (0 !== hash) {
      if ((cfg.external ?? []).includes(-1 === hash ? ref : ref.slice(0, hash))) return null
      fail(`${version}: ${ref} is in a document the generator does not read`)
    }
    // RFC 6901: percent-decode the fragment, split it, then unescape.
    const tokens = decodeURIComponent(ref.slice(1)).split('/')
    if ('' !== tokens[0] || cfg.defs !== tokens[1] || tokens.length < 3) {
      fail(`${version}: ${ref} names no definition`)
    }
    let node = src.doc
    for (const token of tokens.slice(1)) {
      const t = token.replace(/~1/g, '/').replace(/~0/g, '~')
      node = null != node && 'object' === typeof node && Object.hasOwn(node, t) ? node[t] : undefined
      if (undefined === node) fail(`${version}: ${ref} names no definition`)
    }
    return { name: tokens.slice(2).join('/'), node, src }
  }

  // The definition two reference-or-object branches stand for, or null.
  function refableTarget(node, src) {
    if (node.if && node.then && node.else && onlyRef(node.then) && onlyRef(node.else)) {
      const then = deref(node.then.$ref, src)
      const other = deref(node.else.$ref, src)
      if (then && other && cfg.reference.includes(then.name)) return other
    }
    const alts = node.oneOf || node.anyOf
    if (Array.isArray(alts) && 2 === alts.length && alts.every(onlyRef) && !node.properties) {
      const ds = alts.map((a) => deref(a.$ref, src))
      if (ds.every(Boolean)) {
        const i = ds.findIndex((d) => cfg.reference.includes(d.name))
        if (-1 !== i) return ds[1 - i]
      }
    }
    return null
  }

  function stateFor(node, src, hint) {
    if (true === node || false === node || null == node) return 'data'
    if ('object' !== typeof node) return 'data'
    if ('#meta' === node.$dynamicRef) return 'schema'
    const target = refableTarget(node, src)
    if (target) return refable(target)
    // A choice among schema definitions alone is a Schema Object slot, as
    // a 2.0 response's schema is (the schema or the file schema).
    const alts = node.oneOf || node.anyOf
    if (Array.isArray(alts) && 0 < alts.length && alts.every(onlyRef) && !node.properties) {
      const ds = alts.map((a) => deref(a.$ref, src))
      if (ds.every((d) => d && (cfg.schema.includes(d.name) || cfg.reference.includes(d.name)))) {
        return 'schema'
      }
    }
    if (onlyRef(node)) {
      const d = deref(node.$ref, src)
      if (null == d) return 'data'
      if (cfg.schema.includes(d.name)) return 'schema'
      if (cfg.reference.includes(d.name)) return 'reference'
      // A definition that is itself a reference-or-object choice, as 3.1's
      // response-or-reference is.
      const inner = refableTarget(d.node, d.src)
      if (inner) return refable(inner)
      return defState(d)
    }
    return inlineState(node, src, hint, null)
  }

  // The slot that holds a Reference Object or an object of the target's
  // type, named by the type and a question mark.
  function refable(target) {
    if (cfg.schema.includes(target.name)) return 'schema'
    const type = typeName(cfg, target.name)
    const name = type + '?'
    if (!states[name]) {
      states[name] = { kind: 'refable', type, target: null }
      states[name].target = defState(target)
    }
    return name
  }

  // The state of a named definition, built once. Two definitions with one
  // canonical type (3.0's four parameter shapes) share one state, whose
  // members are the union of theirs.
  function defState(d) {
    if (cfg.schema.includes(d.name)) return 'schema'
    const name = typeName(cfg, d.name)
    const key = d.src.url + '#' + d.name
    // Once per definition; while it is being built, a reference back to it
    // (a recursive definition) gets its name.
    if (memo.has(key)) return memo.get(key)
    memo.set(key, name)
    const fresh = null == states[name]
    const acc = states[name] ?? { kind: null, type: name }
    states[name] = acc
    collect(d.node, d.src, name, acc, new Set())
    // A definition with no members to descend into (a string enum, say)
    // is data, not a state.
    if (fresh && null == acc.props && null == acc.patterns && null == acc.rest && null == acc.items) {
      delete states[name]
      memo.set(key, 'data')
      return 'data'
    }
    finish(acc)
    return name
  }

  function inlineState(node, src, hint, type) {
    const acc = { kind: null, type }
    collect(node, src, hint, acc, new Set())
    if (null == acc.props && null == acc.patterns && null == acc.rest && null == acc.items) {
      return 'data'
    }
    finish(acc)
    // Inline states are named by where they are first met.
    let name = hint
    for (let n = 2; states[name] && !same(states[name], acc); n++) name = hint + '~' + n
    states[name] = acc
    return name
  }

  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b)
  }

  function finish(acc) {
    if (null == acc.kind) {
      acc.kind = null != acc.items && null == acc.props && null == acc.patterns && null == acc.rest
        ? 'list'
        : 'object'
    }
  }

  // Gather a node's member transitions into acc, merging what it inherits
  // through `$ref`, allOf, anyOf, oneOf, then, else and dependentSchemas.
  // A union, since the model asks what a position may hold, not which
  // branch a given document takes.
  function collect(node, src, hint, acc, seen) {
    if (null == node || 'object' !== typeof node || seen.has(node)) return
    seen.add(node)
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      acc.props ??= {}
      acc.props[k] = join(acc.props[k], stateFor(v, src, hint + '.' + k))
    }
    for (const [re, v] of Object.entries(node.patternProperties ?? {})) {
      acc.patterns ??= []
      // 2.0's vendorExtension allows an object, which is still the
      // extension author's data.
      const to = EXTENSION === re ? 'data' : stateFor(v, src, hint + '.' + re)
      const at = acc.patterns.findIndex((p) => p[0] === re)
      if (-1 === at) acc.patterns.push([re, to])
      else acc.patterns[at][1] = join(acc.patterns[at][1], to)
    }
    if (undefined !== node.additionalProperties && false !== node.additionalProperties) {
      acc.rest = join(acc.rest, stateFor(node.additionalProperties, src, hint + '.*'))
    }
    if (undefined !== node.items) {
      const items = Array.isArray(node.items) ? node.items : [node.items]
      for (const it of items) acc.items = join(acc.items, stateFor(it, src, hint + '[]'))
    }
    if ('string' === typeof node.$ref && !onlyRef(node)) {
      const d = deref(node.$ref, src)
      if (d) collect(d.node, d.src, hint, acc, seen)
    }
    for (const k of ['allOf', 'anyOf', 'oneOf']) {
      for (const b of node[k] ?? []) branch(b)
    }
    for (const k of ['then', 'else']) if (node[k]) branch(node[k])
    for (const v of Object.values(node.dependentSchemas ?? {})) branch(v)

    function branch(b) {
      if (onlyRef(b)) {
        const d = deref(b.$ref, src)
        if (d && !cfg.reference.includes(d.name) && !cfg.schema.includes(d.name)) {
          collect(d.node, d.src, hint, acc, seen)
        }
      } else {
        collect(b, src, hint, acc, seen)
      }
    }
  }

  // Two answers for one position: the more specific wins, data being the
  // least, and two different structures are a conflict in the schemas the
  // generator refuses to guess about.
  function join(a, b) {
    if (null == a || a === b) return b
    if ('data' === a) return b
    if ('data' === b) return a
    fail(`${version}: one position is both ${a} and ${b}`)
  }

  // The Schema Object, from the dialect's applicator list.
  function schemaState() {
    const props = {}
    for (const k of dialect.schema) props[k] = 'schema'
    for (const k of dialect.schemaOrList) props[k] = 'schema'
    for (const k of dialect.schemaMap) props[k] = 'schema{}'
    for (const k of dialect.schemaList) props[k] = 'schema[]'
    for (const k of dialect.data) props[k] = 'data'
    for (const [k, type] of Object.entries(dialect.objects)) {
      const d = objectDef(type)
      props[k] = d ? defState(d) : 'data'
    }
    props.$ref = 'data'
    states.schema = {
      kind: 'schema',
      type: 'schema',
      dialect: cfg.dialect,
      props,
      patterns: [[EXTENSION, 'data']],
      rest: 'data',
    }
    if (0 < dialect.schemaOrList.length) states.schema.items = 'schema'
    states['schema{}'] = { kind: 'object', type: null, rest: 'schema' }
    states['schema[]'] = { kind: 'list', type: null, items: 'schema' }
  }

  // The definition of an object a Schema Object member holds: the main
  // schema's, else the dialect metaschema's (3.1 and 3.2 define
  // discriminator and xml only there).
  function objectDef(type) {
    for (const src of [main, meta].filter(Boolean)) {
      for (const [name, node] of Object.entries(src.doc[cfg.defs] ?? {})) {
        if (typeName(cfg, name) === type && !cfg.schema.includes(name)) return { name, node, src }
      }
    }
    return null
  }

  states.data = { kind: 'data' }
  states.reference = { kind: 'object', type: 'reference', props: { $ref: 'data' }, rest: 'data' }
  schemaState()
  const root = inlineState(main.doc, main, 'root', 'root')
  if ('root' !== root) fail(`${version}: the root is ${root}`)

  return { dialect: cfg.dialect, source: main.url, meta: meta?.url ?? null, root: 'root', states }
}

// The overlay, applied to one version's states, and gated: an entry with
// no reason, or whose position the generated model does not have, fails.
function applyOverlay(version, model, overlay) {
  const used = []
  overlay.entries.forEach((entry, i) => {
    const where = `overlay entry ${i} (${entry.state})`
    if ('string' !== typeof entry.reason || '' === entry.reason.trim()) {
      fail(`${where} has no reason`)
    }
    if (!Array.isArray(entry.versions) || 0 === entry.versions.length) {
      fail(`${where} names no versions`)
    }
    if (!entry.versions.includes(version)) return
    const state = model.states[entry.state]
    if (null == state) fail(`${where}: ${version} has no state ${entry.state}`)
    if (entry.keys) {
      if (null == state.rest && null == state.patterns) {
        fail(`${where}: ${version} ${entry.state} has no member names to type`)
      }
      leaf(model, entry.keys)
      state.keys = entry.keys
      used.push(i)
      return
    }
    if (!Array.isArray(entry.at) || 0 === entry.at.length || 'string' !== typeof entry.set) {
      fail(`${where} needs at and set, or keys`)
    }
    let holder = state
    let slot = null
    for (let s = 0; s < entry.at.length; s++) {
      const seg = entry.at[s]
      slot = slotOf(model, holder, seg)
      if (null == slot) fail(`${where}: ${version} has no position ${entry.at.slice(0, s + 1).join('/')}`)
      if (s < entry.at.length - 1) holder = model.states[slot.get()]
    }
    // A shared state is never edited in place: the holder gets its own copy.
    slot.set(leaf(model, entry.set))
    used.push(i)
  })
  return used
}

// A transition of a state, as a getter and a setter.
function slotOf(model, state, seg) {
  if (null == state) return null
  if ('*' === seg) {
    if ('list' === state.kind && null != state.items) {
      return { get: () => state.items, set: (v) => (state.items = v) }
    }
    if (null != state.rest) return { get: () => state.rest, set: (v) => (state.rest = v) }
    return null
  }
  if (state.props && Object.prototype.hasOwnProperty.call(state.props, seg)) {
    return { get: () => state.props[seg], set: (v) => (state.props[seg] = v) }
  }
  return null
}

// A leaf state named by an overlay: kind, or kind:type.
function leaf(model, name) {
  if (model.states[name]) return name
  const [kind, type] = name.split(':')
  const KINDS = ['locator', 'connection', 'mapping']
  if (!KINDS.includes(kind)) fail(`unknown leaf ${name}`)
  model.states[name] = null == type ? { kind } : { kind, type }
  return name
}

// Keys sorted, so the output is the same on every run.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (null != value && 'object' === typeof value) {
    const out = {}
    for (const k of Object.keys(value).sort()) {
      if (undefined !== value[k] && null !== value[k]) out[k] = sorted(value[k])
    }
    return out
  }
  return value
}

// The model, from the inputs on disk, or from those given (tests give
// altered ones to show each gate refuses them).
function generate(inputs = {}) {
  const sources = inputs.sources ?? loadSources()
  const applicators = inputs.applicators ?? readJson(Path.join(MODEL, 'applicators.json'))
  const overlay = inputs.overlay ?? readJson(Path.join(MODEL, 'overlay.json'))
  const versions = {}
  const used = new Set()
  for (const version of Object.keys(VERSIONS)) {
    if (null == sources[version]?.schema) fail(`no schema for ${version} in sources.json`)
    const model = build(version, sources, applicators)
    for (const i of applyOverlay(version, model, overlay)) used.add(i)
    versions[version] = sorted(model)
  }
  overlay.entries.forEach((_, i) => {
    if (!used.has(i)) fail(`overlay entry ${i} matched no version`)
  })
  return {
    comment:
      'Generated by tools/object-model.cjs from model/schemas, model/applicators.json and ' +
      'model/overlay.json. Do not edit: change an input and run the tool.',
    versions,
  }
}

function tsSource(model) {
  return (
    '/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */\n\n' +
    '// GENERATED by tools/object-model.cjs from model/. Do not edit: change\n' +
    '// an input under model/ and run `node tools/object-model.cjs`.\n\n' +
    '/* eslint-disable */\n' +
    'const OBJECT_MODEL = ' + JSON.stringify(model, null, 2) + ' as const\n\n' +
    'export { OBJECT_MODEL }\n'
  )
}

function main(argv) {
  const model = generate()
  const json = JSON.stringify(model, null, 2) + '\n'
  const ts = tsSource(model)
  if (argv.includes('--check')) {
    const out = stale()
    if (0 < out.length) {
      console.error('object-model: stale, run `node tools/object-model.cjs`: ' + out.join(', '))
      return 1
    }
    console.log('object-model: up to date')
    return 0
  }
  Fs.writeFileSync(OUT_JSON, json)
  Fs.writeFileSync(OUT_TS, ts)
  const counts = Object.entries(model.versions)
    .map(([v, m]) => `${v}: ${Object.keys(m.states).length} states`)
    .join(', ')
  console.log('object-model: wrote model/object-model.json and ts/src/object-model.ts (' + counts + ')')
  return 0
}

// Whether the committed files are what the inputs generate: the names of
// the stale ones.
function stale() {
  const model = generate()
  const out = []
  const json = JSON.stringify(model, null, 2) + '\n'
  if (!Fs.existsSync(OUT_JSON) || Fs.readFileSync(OUT_JSON, 'utf8') !== json) out.push('model/object-model.json')
  if (!Fs.existsSync(OUT_TS) || Fs.readFileSync(OUT_TS, 'utf8') !== tsSource(model)) out.push('ts/src/object-model.ts')
  return out
}

module.exports = { generate, loadSources, stale, VERSIONS }

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    if (err.objectModel) {
      console.error(err.message)
      process.exitCode = 1
    } else {
      throw err
    }
  }
}
