'use strict'
// One document, in its own process. The driver forks this with the path
// and posts nothing; each phase's result goes back by process.send so a
// timeout or a crash keeps the phases already done.
const Fs = require('node:fs')
const Path = require('node:path')
const PKG = process.env.OPENAPI_DIST || Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js')
const YAMLP = process.env.YAML_REF || 'yaml'
const O = require(PKG)
const YAML = require(YAMLP)

// Every send is awaited before exit: process.exit can drop queued IPC messages.
const pending = []
const send = (phase, data) => { if (process.send) pending.push(new Promise((ok) => process.send({ phase, data }, ok))) }
const flush = () => Promise.all(pending)
const rss = () => process.resourceUsage().maxRSS // KiB, monotonic
const now = () => Number(process.hrtime.bigint()) / 1e6
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

// --- reference YAML: find the yaml node at a JS path, for classification
function yNode(doc, path) {
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

// --- deep comparison: ref vs tab. Returns [{kind, path, ref, tab}]
function compare(ref, tab, limit = 100000) {
  const diffs = []
  const stack = [[ref, tab, []]]
  while (stack.length && diffs.length < limit) {
    const [a, b, path] = stack.pop()
    const ka = kind(a), kb = kind(b)
    if (ka !== kb) {
      // a number and a number-like: both 'number' handled below
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

// Class a diff from the YAML source of the node at its path.
function classify(d, doc, text, refTree) {
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
    }
    cls += `:${style}`
  } else if ('value' === d.k) {
    cls = `value:${d.kr}:${style}${header ? ':' + header.replace(/[0-9]/g, 'N').replace(/\s*#.*/, '') : ''}`
  } else if ('missing' === d.k || 'extra' === d.k) {
    const key = d.path[d.path.length - 1]
    cls = `${d.k}:${'<<' === key ? 'merge-key' : 'key'}:${style}`
  } else cls = `${d.k}:${style}`
  return { cls, at, src, tag, path: ptr(d.path).slice(0, 300), ref: d.ref, tab: d.tab }
}

// Group diffs into classes: count, and the first few samples.
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

// --- YAML feature census, over the CST and the composed document(s)
function yamlFeatures(text, docs) {
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

// --- pointer evaluation on the raw tree, for checking resolver verdicts
function walkPtr(root, frag, { decode = true, follow = false } = {}) {
  let s = frag
  if (decode) { try { s = decodeURIComponent(s) } catch { return { ok: false, err: 'decode' } } }
  if ('' === s) return { ok: true }
  if (!s.startsWith('/')) return { ok: false, err: 'not-pointer' }
  const parts = s.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  let node = root
  for (let i = 0; i < parts.length; i++) {
    let seg = parts[i]
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

async function main() {
  const file = process.argv[2]
  const fast = process.argv[3] !== 'nofast'
  const text = Fs.readFileSync(file, 'utf8')
  const m0 = rss()
  const meta = { bytes: Buffer.byteLength(text), bom: 0xfeff === text.charCodeAt(0), lines: text.split('\n').length, ext: Path.extname(file).toLowerCase(), rssStartKiB: m0 }
  // --- reference
  let refTree, refOk = false, isJson = false, ydoc = null, ydocs = []
  const ref = {}
  let t = now()
  try { refTree = JSON.parse(text); isJson = true; refOk = true; ref.json = { ok: true } } catch (e) { ref.json = { ok: false, msg: firstLine(e.message) } }
  ref.jsonMs = now() - t
  meta.format = isJson ? 'json' : ('.json' === meta.ext ? 'json-invalid' : 'yaml')
  if (!isJson) {
    t = now()
    try {
      ydocs = YAML.parseAllDocuments(text, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, prettyErrors: false, keepSourceTokens: false })
      if (!Array.isArray(ydocs)) ydocs = [ydocs] // EmptyStream
      ref.yamlDocs = ydocs.length
      ydoc = ydocs[0] ?? null
      const errs = ydocs.flatMap((d) => d.errors)
      ref.yaml = { ok: 0 === errs.length && 1 === ydocs.length, errors: errs.slice(0, 5).map((e) => ({ code: e.code, msg: firstLine(e.message), pos: e.pos?.[0], at: e.pos ? lineOf(text, e.pos[0]) : null })), nErrors: errs.length, warnings: ydocs.flatMap((d) => d.warnings).slice(0, 3).map((e) => ({ code: e.code, msg: firstLine(e.message) })) }
      if (1 === ydocs.length && 0 === errs.length) {
        refTree = ydoc.toJS({ maxAliasCount: -1 }); refOk = true
      } else if (1 === ydocs.length) {
        // only duplicate keys? then build a tree with them allowed
        const codes = new Set(errs.map((e) => e.code))
        if (1 === codes.size && codes.has('DUPLICATE_KEY')) {
          const d2 = YAML.parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false })
          if (0 === d2.errors.length) { refTree = d2.toJS({ maxAliasCount: -1 }); ref.dupKeysOnly = true; ydoc = d2 }
        }
      }
      // with merge keys
      if (1 === ydocs.length) {
        const dm = YAML.parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: false, merge: true })
        ref.yamlMerge = { ok: 0 === dm.errors.length, errors: dm.errors.slice(0, 3).map((e) => ({ code: e.code, msg: firstLine(e.message) })) }
        if (0 === dm.errors.length) ref._mergeTree = dm.toJS({ maxAliasCount: -1 })
      }
    } catch (e) { ref.yaml = { ok: false, threw: errInfo(e) } }
    ref.yamlMs = now() - t
  }
  const refMerge = ref._mergeTree; delete ref._mergeTree
  ref.rssKiB = rss()
  // declared version
  const vt = refTree ?? refMerge
  if (isMap(vt)) { meta.openapi = trunc(vt.openapi); meta.swagger = trunc(vt.swagger); meta.version = O.version(vt).version } else meta.version = null === vt || undefined === vt ? 'none' : 'not-a-map'
  if (!isJson) meta.features = yamlFeatures(text, ydocs)
  send('meta', meta)
  send('ref', ref)

  // --- tabnas parse (default)
  let tree, parsed = false
  t = now()
  try { tree = O.parse(text, fast ? {} : { fast: false }); parsed = true; send('parse', { ok: true, ms: now() - t, rssKiB: rss(), heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576) }) }
  catch (e) { send('parse', { ok: false, ms: now() - t, err: errInfo(e), rssKiB: rss() }) }

  // --- compare
  if (parsed && refOk) {
    t = now()
    const diffs = compare(refTree, tree)
    const out = { n: diffs.length, ms: 0 }
    if (diffs.length) {
      out.classes = groupDiffs(diffs, ydoc, text)
      if (refMerge) { const dm = compare(refMerge, tree); out.nVsMerge = dm.length; if (dm.length && dm.length !== diffs.length) out.classesVsMerge = groupDiffs(dm, ydoc, text) }
      // against YAML 1.1 schema too, to label 1.1-isms
      if (!isJson) {
        try { const d11 = YAML.parseDocument(text, { version: '1.1', uniqueKeys: false, merge: true }); if (!d11.errors.length) out.nVs11 = compare(d11.toJS({ maxAliasCount: -1 }), tree).length } catch {}
      }
    }
    out.ms = now() - t
    send('compare', out)
  } else if (parsed && !refOk && refMerge) {
    const dm = compare(refMerge, tree); send('compare', { n: null, nVsMerge: dm.length, classesVsMerge: dm.length ? groupDiffs(dm, ydoc, text) : undefined })
  }

  // --- JSON: the grammar path and strict
  if (isJson) {
    t = now()
    try { const g = O.parse(text, { fast: false }); const ms = now() - t; const d = compare(refTree, g); send('grammar', { ok: true, ms, n: d.length, classes: d.length ? groupDiffs(d, null, text) : undefined, rssKiB: rss() }) }
    catch (e) { send('grammar', { ok: false, ms: now() - t, err: errInfo(e) }) }
    t = now()
    try { O.parse(text, { strict: true }); send('strict', { ok: true, ms: now() - t }) }
    catch (e) { send('strict', { ok: false, ms: now() - t, err: errInfo(e) }) }
  }

  // --- resolve
  const rtree = parsed ? tree : null
  if (parsed && 'unknown' !== O.version(rtree).version) {
    t = now()
    let r
    try { r = O.resolve(rtree) } catch (e) { send('resolve', { ok: false, ms: now() - t, err: errInfo(e), rssKiB: rss() }); r = null }
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
        const ref = 'string' === typeof u.ref ? u.ref : null
        if (null != ref && ref.startsWith('#')) {
          const frag = ref.slice(1)
          if (frag.startsWith('/') || /^%2f/i.test(frag)) {
            const a = walkPtr(rtree, frag, { decode: true })
            const b = a.ok ? a : walkPtr(rtree, frag, { decode: false })
            const c = a.ok || b.ok ? a : walkPtr(rtree, frag, { decode: true, follow: true })
            verdict = a.ok ? 'target-exists' : b.ok ? 'exists-undecoded-only' : c.ok ? 'exists-via-ref' : 'absent:' + a.err
          } else {
            anchors ??= findAnchors(rtree)
            verdict = anchors.has(frag) ? 'anchor-declared' : anchors.has('id#' + frag) ? 'anchor-in-id-fragment' : /^[A-Za-z_][-A-Za-z0-9._]*$/.test(frag) ? 'anchor-absent' : 'fragment-not-anchor-syntax'
          }
        } else if (null != ref) verdict = 'not-fragment-only'
        g.verdicts[verdict] = (g.verdicts[verdict] ?? 0) + 1
        if (g.samples.length < 6) g.samples.push({ at: u.at.slice(0, 200), ref: trunc(u.ref), verdict })
      }
      const rr = { ok: true, ms, version: r.version, sites: r.provenance.length, status, kinds, why, cuts: r.cuts.length, cutSamples: r.cuts.slice(0, 2), dataSlots: r.dataSlots, connections: conn, connMissing, checks, ext, rssKiB: rss() }
      send('resolve', rr)
    }
  } else if (parsed) send('resolve', { skipped: 'no-version' })
  send('done', { rssKiB: rss() })
}
if (require.main === module) main().then(() => flush().then(() => process.exit(0)), (e) => { send('crash', errInfo(e)); flush().then(() => process.exit(1)) })
module.exports = { compare, groupDiffs, classify, yNode, errInfo, extForm, walkPtr, YAML, O }
