/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/examine.cjs: what the package does with one document.
//
// `examine(text, options)` reads the text with the reference parsers
// (`JSON.parse`, and the npm `yaml` package under YAML 1.2's core schema),
// parses it with the package under test, compares the two trees and
// classifies every difference by the YAML source of the value, reads a
// JSON document a second time on the grammar path and under `strict`,
// and resolves a description, counting what `resolve` reports. Each phase's
// result goes to `options.send(phase, data)` as soon as it is known, so a
// worker that is killed part-way keeps the phases already done; the
// return value is the whole record.
//
// The package under test is ts/dist/openapi.js unless OPENAPI_DIST names
// another. The reference YAML parser is the `yaml` development dependency
// of ts/package.json, resolved from there. Both load on first use, so the
// classifying code (compare, classify) can be required without them.
//
// A module for worker.cjs, the test in ts/test/corpus-tool.test.ts and
// the scripts beside it; it runs nothing by itself.

const Path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = Path.join(__dirname, '..', '..')
const DIST = () => Path.resolve(process.env.OPENAPI_DIST || Path.join(ROOT, 'ts', 'dist', 'openapi.js'))
const TS_REQUIRE = createRequire(Path.join(ROOT, 'ts', 'package.json'))

let loaded = null
function load() {
  if (loaded) return loaded
  const dist = DIST()
  loaded = { O: require(dist), YAML: TS_REQUIRE('yaml'), dist }
  return loaded
}

// The phases of a record, in the order examine sends them.
const PHASES = ['meta', 'ref', 'parse', 'compare', 'grammar', 'strict', 'resolve', 'done']

const firstLine = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 300)
const trunc = (v) => {
  if ('string' === typeof v) return v.length > 120 ? v.slice(0, 117) + '...' : v
  if ('number' === typeof v) return Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : Object.is(v, -0) ? '-0' : v
  if (v instanceof Date) return 'Date(' + (isNaN(v) ? 'invalid' : v.toISOString()) + ')'
  if (Array.isArray(v)) return '[array ' + v.length + ']'
  if (null != v && 'object' === typeof v) return '{map ' + Object.keys(v).length + '}'
  return v
}
const kind = (v) => {
  if (null === v) return 'null'
  if (undefined === v) return 'undefined'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  if ('bigint' === typeof v) return 'bigint'
  if (v instanceof Map) return 'jsmap'
  if (v instanceof Set) return 'jsset'
  if (v instanceof Uint8Array) return 'binary'
  return typeof v
}
const isMap = (v) => null != v && 'object' === typeof v && !Array.isArray(v)
const ptr = (path) => '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')

function errInfo(e) {
  let j = null
  try { j = 'function' === typeof e?.toJSON ? e.toJSON() : null } catch {}
  return {
    name: e?.name, code: e?.code ?? null, msg: firstLine(e?.message),
    row: j?.row, col: j?.col, rule: j?.rule, token: j?.token,
    stack: e?.code ? undefined : String(e?.stack ?? '').split('\n').slice(0, 6).join(' | ').slice(0, 800),
  }
}

// The reference parser's node at a path of the JS tree, for classification.
function yNode(doc, path) {
  const { YAML } = load()
  let node = doc.contents
  for (const seg of path) {
    if (YAML.isAlias(node)) node = node.resolve(doc)
    if (YAML.isMap(node)) {
      let hit = null
      for (const pair of node.items) {
        let k = pair.key
        if (YAML.isAlias(k)) k = k.resolve(doc)
        const kv = YAML.isScalar(k) ? k.value : k
        if (String(kv) === String(seg)) hit = pair // last wins
      }
      if (null == hit) return null
      node = hit.value
    } else if (YAML.isSeq(node)) {
      node = node.items[Number(seg)]
    } else return null
    if (null == node) return null
  }
  if (YAML.isAlias(node)) node = node.resolve(doc)
  return node
}
function lineOf(text, offset) {
  let row = 1
  for (let i = 0; i < offset && i < text.length; i++) if (10 === text.charCodeAt(i)) row++
  const s = text.lastIndexOf('\n', offset - 1) + 1
  const e = text.indexOf('\n', offset)
  return { row, line: text.slice(s, -1 === e ? undefined : e).slice(0, 200) }
}

// Deep comparison, reference against the package, ignoring member order.
// Returns [{ k, path, ref, tab, kr, kt }], at most `limit` of them.
function compare(ref, tab, limit = 100000) {
  const diffs = []
  const stack = [[ref, tab, []]]
  while (stack.length && diffs.length < limit) {
    const [a, b, path] = stack.pop()
    const ka = kind(a), kb = kind(b)
    if (ka !== kb) {
      diffs.push({ k: 'type', path, ref: trunc(a), tab: trunc(b), kr: ka, kt: kb })
      continue
    }
    if ('array' === ka) {
      if (a.length !== b.length) diffs.push({ k: 'length', path, ref: a.length, tab: b.length })
      for (let i = Math.min(a.length, b.length) - 1; i >= 0; i--) stack.push([a[i], b[i], [...path, i]])
    } else if ('object' === ka) {
      const kA = Object.keys(a), kB = Object.keys(b)
      const sB = new Set(kB), sA = new Set(kA)
      for (const k of kA) if (!sB.has(k)) diffs.push({ k: 'missing', path: [...path, k], ref: trunc(a[k]) })
      for (const k of kB) if (!sA.has(k)) diffs.push({ k: 'extra', path: [...path, k], tab: trunc(b[k]) })
      for (let i = kA.length - 1; i >= 0; i--) if (sB.has(kA[i])) stack.push([a[kA[i]], b[kA[i]], [...path, kA[i]]])
    } else if ('number' === ka) {
      if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) diffs.push({ k: 'value', path, ref: trunc(a), tab: trunc(b), kr: ka })
    } else if ('date' === ka) {
      if (a.getTime() !== b.getTime()) diffs.push({ k: 'value', path, ref: trunc(a), tab: trunc(b), kr: ka })
    } else if (a !== b) diffs.push({ k: 'value', path, ref: trunc(a), tab: trunc(b), kr: ka })
  }
  return diffs
}

// Comment syntax a YAML plain scalar may hold, which jsonic reads as a comment.
const COMMENTISH = /^(\/\/|\/\*)/

// The class of one difference, from the YAML source of the value at its
// path: `<what>:<detail>:<node style>`. Three suffixes name the kinds the
// plan counts: `yaml11-bool-word`, `underscore` and `comment-syntax`.
function classify(d, doc, text) {
  const { YAML } = load()
  const node = doc ? yNode(doc, d.k === 'missing' || d.k === 'extra' ? d.path.slice(0, -1) : d.path) : null
  let style = null, src = null, at = null, header = null, tag = null
  if (node) {
    if (YAML.isScalar(node)) style = node.type
    else if (YAML.isMap(node)) style = node.flow ? 'FLOW_MAP' : 'BLOCK_MAP'
    else if (YAML.isSeq(node)) style = node.flow ? 'FLOW_SEQ' : 'BLOCK_SEQ'
    tag = node.tag ?? null
    if (node.range) {
      at = lineOf(text, node.range[0])
      src = text.slice(node.range[0], Math.min(node.range[1], node.range[0] + 160))
      if ('BLOCK_LITERAL' === style || 'BLOCK_FOLDED' === style) header = text.slice(node.range[0], text.indexOf('\n', node.range[0])).trim()
    }
  }
  let cls
  if ('type' === d.k) {
    cls = `type:${d.kr}->${d.kt}`
    if ('string' === d.kr && 'boolean' === d.kt) cls += /^(yes|no|on|off|y|n)$/i.test(d.ref) ? ':yaml11-bool-word' : ':other'
    else if ('string' === d.kr && 'number' === d.kt) {
      const s = String(d.ref)
      cls += /_/.test(s) ? ':underscore' : /^[-+]?0[0-7]+$/.test(s) ? ':leading-zero-octal' : /^[-+]?0b/i.test(s) ? ':binary' : /^[-+]?0x/i.test(s) ? ':hex' : /^[-+]?\d+(\.\d*)?[eE]/.test(s) || /^[-+]?\.\d/.test(s) ? ':float-form' : /:/.test(s) ? ':sexagesimal' : /^[-+]?0\d/.test(s) ? ':leading-zero' : ':other'
    } else if ('number' === d.kr && 'string' === d.kt) {
      cls += ':' + (/^[-+]?0o/i.test(String(src)) ? 'octal-0o' : /^[-+]?0x/i.test(String(src)) ? 'hex' : /^\+/.test(String(src)) ? 'plus-sign' : /^[-+]?\./.test(String(src)) ? 'leading-dot' : /\.$/.test(String(src).trim()) ? 'trailing-dot' : /[eE]/.test(String(src)) ? 'exp' : 'other')
    } else if ('null' === d.kt && 'PLAIN' === style && COMMENTISH.test(String(src ?? d.ref))) cls += ':comment-syntax'
    cls += `:${style}`
  } else if ('value' === d.k) {
    cls = `value:${d.kr}:${style}${header ? ':' + header.replace(/[0-9]/g, 'N').replace(/\s*#.*/, '') : ''}`
    if ('string' === d.kr && 'PLAIN' === style && /\s(\/\/|\/\*)/.test(String(src ?? '')) && 'string' === typeof d.tab && String(d.ref).startsWith(d.tab.trimEnd())) cls += ':comment-syntax'
  } else if ('missing' === d.k || 'extra' === d.k) {
    const key = d.path[d.path.length - 1]
    cls = `${d.k}:${'<<' === key ? 'merge-key' : 'key'}:${style}`
  } else cls = `${d.k}:${style}`
  return { cls, at, src, tag, path: ptr(d.path).slice(0, 300), ref: d.ref, tab: d.tab }
}

// The plan's kind of a class: a reading made on purpose, comment syntax, or other.
function kindOfClass(cls) {
  if (/:yaml11-bool-word(:|$)/.test(cls)) return 'yaml11-word'
  if (/:underscore(:|$)/.test(cls)) return 'underscore-number'
  if (/:comment-syntax(:|$)/.test(cls)) return 'comment-syntax'
  return 'other'
}

// Differences grouped by class: a count, and the first few samples.
function groupDiffs(diffs, doc, text) {
  const classes = {}
  for (const d of diffs) {
    const c = classify(d, doc, text)
    const g = (classes[c.cls] ??= { n: 0, samples: [] })
    g.n++
    if (g.samples.length < 3) g.samples.push(c)
  }
  return classes
}

// YAML features used, from the reference parser's CST and documents.
function yamlFeatures(text, docs) {
  const { YAML } = load()
  const f = { anchors: 0, aliases: 0, mergeKeys: 0, tags: 0, tagNames: {}, docStart: 0, docEnd: 0, directives: 0, docs: docs.length, nonStringKeys: {}, complexKeys: 0, flowCollections: 0, blockScalars: 0 }
  try {
    for (const tok of new YAML.Parser().parse(text)) {
      const st = [tok]
      while (st.length) {
        const t = st.pop()
        if (Array.isArray(t)) { for (const x of t) st.push(x); continue }
        if (null == t || 'object' !== typeof t) continue
        if ('anchor' === t.type) f.anchors++
        else if ('alias' === t.type) f.aliases++
        else if ('tag' === t.type) { f.tags++; const n = String(t.source); f.tagNames[n] = (f.tagNames[n] ?? 0) + 1 }
        else if ('doc-start' === t.type) f.docStart++
        else if ('doc-end' === t.type) f.docEnd++
        else if ('directive' === t.type) f.directives++
        else if ('flow-collection' === t.type) f.flowCollections++
        else if ('block-scalar' === t.type) f.blockScalars++
        for (const k of Object.keys(t)) if ('object' === typeof t[k]) st.push(t[k])
      }
    }
  } catch (e) { f.cstError = firstLine(e.message) }
  for (const doc of docs) {
    YAML.visit(doc, {
      Pair(_, pair) {
        const k = pair.key
        if (YAML.isScalar(k)) {
          if ('<<' === k.value) f.mergeKeys++
          else if ('string' !== typeof k.value) { const t = kind(k.value); f.nonStringKeys[t] = (f.nonStringKeys[t] ?? 0) + 1 }
        } else if (YAML.isAlias(k)) f.nonStringKeys.alias = (f.nonStringKeys.alias ?? 0) + 1
        else if (null != k) f.complexKeys++
      },
    })
  }
  return f
}

// RFC 6901 on the raw tree, to check what `resolve` says it could not find.
function walkPtr(root, frag, { decode = true, follow = false } = {}) {
  let s = frag
  if (decode) { try { s = decodeURIComponent(s) } catch { return { ok: false, err: 'decode' } } }
  if ('' === s) return { ok: true }
  if (!s.startsWith('/')) return { ok: false, err: 'not-pointer' }
  const parts = s.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  let node = root
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    let guard = 0
    while (follow && isMap(node) && 'string' === typeof node.$ref && node.$ref.startsWith('#') && !Object.prototype.hasOwnProperty.call(node, seg) && guard++ < 50) {
      const r = walkPtr(root, node.$ref.slice(1), { decode, follow })
      if (!r.ok) return { ok: false, err: 'via-ref-broken', at: i }
      node = r.node
    }
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(seg) || Number(seg) >= node.length) return { ok: false, err: 'index', at: i, seg }
      node = node[Number(seg)]
    } else if (isMap(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, seg)) return { ok: false, err: 'absent', at: i, seg }
      node = node[seg]
    } else return { ok: false, err: 'scalar', at: i, seg }
  }
  return { ok: true, node }
}
function findAnchors(root) {
  const out = new Set()
  const st = [root]
  while (st.length) {
    const n = st.pop()
    if (Array.isArray(n)) { for (const x of n) st.push(x); continue }
    if (!isMap(n)) continue
    for (const k of ['$anchor', '$dynamicAnchor']) if ('string' === typeof n[k]) out.add(n[k])
    for (const k of ['$id', 'id']) if ('string' === typeof n[k] && n[k].includes('#')) out.add('id#' + n[k].split('#')[1])
    for (const k of Object.keys(n)) if ('object' === typeof n[k]) st.push(n[k])
  }
  return out
}

// The form of a reference into another document: `<base>:<extension>:<fragment>`.
function extForm(ref) {
  if ('string' !== typeof ref) return 'non-string'
  const hash = ref.indexOf('#')
  const docPart = -1 === hash ? ref : ref.slice(0, hash)
  const frag = -1 === hash ? null : ref.slice(hash + 1)
  const fragKind = null == frag ? 'nofrag' : '' === frag ? 'emptyfrag' : frag.startsWith('/') ? 'ptrfrag' : 'anchorfrag'
  let base
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(docPart)) base = /json-schema\.org/.test(docPart) ? 'url:json-schema.org' : /^https?:/i.test(docPart) ? 'url:http' : 'url:other'
  else if (/^urn:/i.test(docPart)) base = 'urn'
  else if (/^[a-z][a-z0-9+.-]*:/i.test(docPart)) base = 'uri:other-scheme'
  else if ('' === docPart) base = 'same-doc?'
  else base = 'relative'
  const ext = (docPart.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'none').toLowerCase()
  return `${base}:${['json', 'yaml', 'yml'].includes(ext) ? ext : ext === 'none' ? 'noext' : 'other-ext'}:${fragKind}`
}

const rss = () => process.resourceUsage().maxRSS // KiB, monotonic
const now = () => Number(process.hrtime.bigint()) / 1e6

// One document, every phase. `ext` is the file's extension, which only
// tells a JSON file that is not JSON from YAML. `fast: false` sends JSON
// text to the grammar as well.
function examine(text, { ext = '', fast = true, send = () => {} } = {}) {
  const { O, YAML } = load()
  const record = {}
  const emit = (phase, data) => { record[phase] = data; send(phase, data) }
  const meta = { bytes: Buffer.byteLength(text), bom: 0xfeff === text.charCodeAt(0), lines: text.split('\n').length, ext: String(ext).toLowerCase(), rssStartKiB: rss() }

  // The reference trees.
  let refTree, refOk = false, isJson = false, ydoc = null, ydocs = []
  const ref = {}
  let t = now()
  try { refTree = JSON.parse(text); isJson = true; refOk = true; ref.json = { ok: true } } catch (e) { ref.json = { ok: false, msg: firstLine(e.message) } }
  ref.jsonMs = now() - t
  meta.format = isJson ? 'json' : ('.json' === meta.ext ? 'json-invalid' : 'yaml')
  let refMerge
  if (!isJson) {
    t = now()
    try {
      ydocs = YAML.parseAllDocuments(text, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, prettyErrors: false, keepSourceTokens: false })
      if (!Array.isArray(ydocs)) ydocs = [ydocs] // an empty stream
      ref.yamlDocs = ydocs.length
      ydoc = ydocs[0] ?? null
      const errs = ydocs.flatMap((d) => d.errors)
      ref.yaml = { ok: 0 === errs.length && 1 === ydocs.length, errors: errs.slice(0, 5).map((e) => ({ code: e.code, msg: firstLine(e.message), pos: e.pos?.[0], at: e.pos ? lineOf(text, e.pos[0]) : null })), nErrors: errs.length, warnings: ydocs.flatMap((d) => d.warnings).slice(0, 3).map((e) => ({ code: e.code, msg: firstLine(e.message) })) }
      if (1 === ydocs.length && 0 === errs.length) {
        refTree = ydoc.toJS({ maxAliasCount: -1 }); refOk = true
      } else if (1 === ydocs.length) {
        // Duplicate keys alone: build the tree with them allowed.
        const codes = new Set(errs.map((e) => e.code))
        if (1 === codes.size && codes.has('DUPLICATE_KEY')) {
          const d2 = YAML.parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false })
          if (0 === d2.errors.length) { refTree = d2.toJS({ maxAliasCount: -1 }); ref.dupKeysOnly = true; ydoc = d2 }
        }
      }
      if (1 === ydocs.length) {
        const dm = YAML.parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: false, merge: true })
        ref.yamlMerge = { ok: 0 === dm.errors.length, errors: dm.errors.slice(0, 3).map((e) => ({ code: e.code, msg: firstLine(e.message) })) }
        if (0 === dm.errors.length) refMerge = dm.toJS({ maxAliasCount: -1 })
      }
    } catch (e) { ref.yaml = { ok: false, threw: errInfo(e) } }
    ref.yamlMs = now() - t
  }
  ref.rssKiB = rss()
  const vt = refTree ?? refMerge
  if (isMap(vt)) { meta.openapi = trunc(vt.openapi); meta.swagger = trunc(vt.swagger); meta.version = O.version(vt).version } else meta.version = null == vt ? 'none' : 'not-a-map'
  if (!isJson) meta.features = yamlFeatures(text, ydocs)
  emit('meta', meta)
  emit('ref', ref)

  // The package, by default.
  let tree, parsed = false
  t = now()
  try { tree = O.parse(text, fast ? {} : { fast: false }); parsed = true; emit('parse', { ok: true, ms: now() - t, rssKiB: rss(), heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576) }) }
  catch (e) { emit('parse', { ok: false, ms: now() - t, err: errInfo(e), rssKiB: rss() }) }

  // The trees.
  if (parsed && refOk) {
    t = now()
    const diffs = compare(refTree, tree)
    const out = { n: diffs.length, ms: 0 }
    if (diffs.length) {
      out.classes = groupDiffs(diffs, ydoc, text)
      if (refMerge) { const dm = compare(refMerge, tree); out.nVsMerge = dm.length; if (dm.length && dm.length !== diffs.length) out.classesVsMerge = groupDiffs(dm, ydoc, text) }
      if (!isJson) {
        try { const d11 = YAML.parseDocument(text, { version: '1.1', uniqueKeys: false, merge: true }); if (!d11.errors.length) out.nVs11 = compare(d11.toJS({ maxAliasCount: -1 }), tree).length } catch {}
      }
    }
    out.ms = now() - t
    emit('compare', out)
  } else if (parsed && !refOk && refMerge) {
    const dm = compare(refMerge, tree)
    emit('compare', { n: null, nVsMerge: dm.length, classesVsMerge: dm.length ? groupDiffs(dm, ydoc, text) : undefined })
  }

  // JSON: the grammar path and strict.
  if (isJson) {
    t = now()
    try { const g = O.parse(text, { fast: false }); const ms = now() - t; const d = compare(refTree, g); emit('grammar', { ok: true, ms, n: d.length, classes: d.length ? groupDiffs(d, null, text) : undefined, rssKiB: rss() }) }
    catch (e) { emit('grammar', { ok: false, ms: now() - t, err: errInfo(e) }) }
    t = now()
    try { O.parse(text, { strict: true }); emit('strict', { ok: true, ms: now() - t }) }
    catch (e) { emit('strict', { ok: false, ms: now() - t, err: errInfo(e) }) }
  }

  // resolve, on a description.
  if (parsed && 'unknown' !== O.version(tree).version) {
    t = now()
    let r
    try { r = O.resolve(tree) } catch (e) { emit('resolve', { ok: false, ms: now() - t, err: errInfo(e), rssKiB: rss() }); r = null }
    if (r) {
      const ms = now() - t
      const status = {}, kinds = {}, why = {}, conn = {}, connMissing = {}
      for (const p of r.provenance) { status[p.status] = (status[p.status] ?? 0) + 1; kinds[p.kind] = (kinds[p.kind] ?? 0) + 1 }
      for (const u of r.unresolved) why[u.why] = (why[u.why] ?? 0) + 1
      for (const c of r.connections) { conn[c.kind] = (conn[c.kind] ?? 0) + 1; if (!c.found) connMissing[c.kind] = (connMissing[c.kind] ?? 0) + 1 }
      const checks = {}
      let anchors = null
      const ext = { forms: {}, refs: {} }
      for (const u of r.unresolved) {
        if ('external' === u.why) {
          const f = extForm(u.ref); ext.forms[f] = (ext.forms[f] ?? 0) + 1
          const key = String(u.ref).split('#')[0]
          if (Object.keys(ext.refs).length < 400 || key in ext.refs) ext.refs[key] = (ext.refs[key] ?? 0) + 1
          continue
        }
        if (!['not-found', 'bad-fragment', 'no-anchor', 'unsupported-dialect'].includes(u.why)) continue
        const g = (checks[u.why] ??= { n: 0, verdicts: {}, samples: [] })
        g.n++
        let verdict = 'unchecked'
        const rf = 'string' === typeof u.ref ? u.ref : null
        if (null != rf && rf.startsWith('#')) {
          const frag = rf.slice(1)
          if (frag.startsWith('/') || /^%2f/i.test(frag)) {
            const a = walkPtr(tree, frag, { decode: true })
            const b = a.ok ? a : walkPtr(tree, frag, { decode: false })
            const c = a.ok || b.ok ? a : walkPtr(tree, frag, { decode: true, follow: true })
            verdict = a.ok ? 'target-exists' : b.ok ? 'exists-undecoded-only' : c.ok ? 'exists-via-ref' : 'absent:' + a.err
          } else {
            anchors ??= findAnchors(tree)
            verdict = anchors.has(frag) ? 'anchor-declared' : anchors.has('id#' + frag) ? 'anchor-in-id-fragment' : /^[A-Za-z_][-A-Za-z0-9._]*$/.test(frag) ? 'anchor-absent' : 'fragment-not-anchor-syntax'
          }
        } else if (null != rf) verdict = 'not-fragment-only'
        g.verdicts[verdict] = (g.verdicts[verdict] ?? 0) + 1
        if (g.samples.length < 6) g.samples.push({ at: u.at.slice(0, 200), ref: trunc(u.ref), verdict })
      }
      emit('resolve', { ok: true, ms, version: r.version, sites: r.provenance.length, status, kinds, why, cuts: r.cuts.length, cutSamples: r.cuts.slice(0, 2), dataSlots: r.dataSlots, connections: conn, connMissing, checks, ext, rssKiB: rss() })
    }
  } else if (parsed) emit('resolve', { skipped: 'no-version' })
  emit('done', { rssKiB: rss() })
  return record
}

module.exports = { PHASES, load, examine, compare, classify, groupDiffs, kindOfClass, yNode, yamlFeatures, errInfo, extForm, walkPtr, findAnchors, ptr }
