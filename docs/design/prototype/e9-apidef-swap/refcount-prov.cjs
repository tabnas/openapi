// refcount-prov.cjs BASE_DIST OPENAPI_DIST FILE... | --tsv FILE
// Compares apidef's countRefs(parse(src)) with a count built from
// @tabnas/openapi's provenance report alone.
const fs = require('fs')
const [base, oaDist, ...rest] = process.argv.slice(2)
const ap = require(base + '/parse.js')
const rc = require(base + '/refcount.js')
const oa = require(oaDist)

function ptrGet(root, ptr) {
  if ('' === ptr) return root
  let n = root
  for (const raw of ptr.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (null == n || 'object' !== typeof n || !Object.prototype.hasOwnProperty.call(n, k)) return undefined
    n = n[k]
  }
  return n
}
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1')
const hasKids = (v) => null != v && 'object' === typeof v && 0 < Object.keys(v).length
const nodeKey = (label, over) => [label, ...over].map((p) => p.replace(/[\0\x01]/g, (c) => '\0' === c ? '\x01\x01' : '\x01\x02')).join('\0')
function countFromProvenance(prov, raw, tree) {
  const sites = prov.filter((p) => 'string' === typeof p.ref)
  const siteAt = new Map(sites.map((s) => [s.at, s]))
  const targetOf = new Map()
  for (const s of sites) if (null != s.target && !targetOf.has(s.ref)) targetOf.set(s.ref, s.target)
  // The node a site counts as: its label, and the sibling keys that replace a
  // target member with children of a different value.
  const nodeOf = (s) => {
    const t = targetOf.get(s.ref), over = []
    const rawSite = ptrGet(raw, s.at)
    if (null != t) {
      const tv = ptrGet(tree, t)
      for (const k of Object.keys(rawSite)) {
        if ('$ref' === k) continue
        if (null == tv || 'object' !== typeof tv || !Object.prototype.hasOwnProperty.call(tv, k)) continue
        const rk = rawSite[k], rt = ptrGet(raw, t + '/' + esc(k))
        const lab = (v) => (null != v && 'object' === typeof v && 'string' === typeof v.$ref) ? v.$ref : undefined
        if (undefined !== lab(rk) && lab(rk) === lab(rt)) continue
        if (hasKids(tv[k])) over.push(k)
      }
    }
    over.sort(rc.byCodePoint)
    return { key: nodeKey(s.ref, over), label: s.ref, over }
  }
  const under = (at, base) => at.startsWith(base + '/')
  const bodySites = (T, excl, seen = new Set()) => {
    if (seen.has(T)) return []
    seen.add(T)
    const out = sites.filter((s) => under(s.at, T) && !excl.some((k) => s.at === T + '/' + esc(k) || under(s.at, T + '/' + esc(k))))
    const ts = siteAt.get(T)
    if (ts && null != ts.target) {
      const rawT = ptrGet(raw, T)
      const more = excl.concat(Object.keys(rawT).filter((k) => '$ref' !== k))
      out.push(...bodySites(ts.target, more, seen))
    }
    return out
  }
  const ROOT = '\x01ROOT'
  const bodies = new Map(), labelOf = new Map(), overOf = new Map()
  const add = (b, s) => { const n = nodeOf(s); labelOf.set(n.key, n.label); overOf.set(n.key, n.over); b.set(n.key, (b.get(n.key) ?? 0) + 1) }
  const rootBody = new Map(); for (const s of sites) add(rootBody, s)
  bodies.set(ROOT, rootBody)
  const todo = [...rootBody.keys()]
  for (let i = 0; i < todo.length; i++) {
    const key = todo[i]; if (bodies.has(key)) continue
    const t = targetOf.get(labelOf.get(key)); const b = new Map()
    if (null != t) for (const s of bodySites(t, overOf.get(key))) add(b, s)
    bodies.set(key, b)
    for (const k of b.keys()) if (!bodies.has(k)) todo.push(k)
  }
  // countPaths as in apidef's refcount.ts
  const byCP = rc.byCodePoint
  const successors = (u) => [...bodies.get(u).keys()].sort(byCP)
  const onStack = new Set([ROOT]), finished = new Set(), back = new Map(), post = []
  const stack = [{ node: ROOT, next: successors(ROOT), i: 0 }]
  while (stack.length) {
    const f = stack[stack.length - 1]
    if (f.i < f.next.length) {
      const v = f.next[f.i++]
      if (onStack.has(v)) { let c = back.get(f.node); if (!c) back.set(f.node, c = new Set()); c.add(v) }
      else if (!finished.has(v)) { onStack.add(v); stack.push({ node: v, next: successors(v), i: 0 }) }
    } else { stack.pop(); onStack.delete(f.node); finished.add(f.node); post.push(f.node) }
  }
  const count = new Map([[ROOT, 1]])
  for (let i = post.length - 1; 0 <= i; i--) {
    const u = post[i], cu = count.get(u) ?? 0, cut = back.get(u)
    for (const [v, w] of bodies.get(u)) { if (cut?.has(v)) continue; count.set(v, rc.satAdd(count.get(v) ?? 0, rc.satMul(cu, w))) }
  }
  const out = {}
  for (const [key, label] of labelOf) out[label] = rc.satAdd(out[label] ?? 0, count.get(key) ?? 0)
  return out
}
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))
;(async () => {
  let items = []
  if ('--tsv' === rest[0]) {
    const lines = fs.readFileSync(rest[1], 'utf8').split('\n').filter(Boolean)
    const head = lines[0].split('\t')
    for (const line of lines.slice(1)) { const c = line.split('\t'); const row = {}; head.forEach((h, i) => row[h] = c[i]); items.push({ name: row.name, src: row.spec, expected: JSON.parse(row.expected) }) }
  } else items = rest.map((f) => ({ name: f.replace(/.*\//, ''), src: fs.readFileSync(f, 'utf8') }))
  let same = 0, n = 0
  for (const it of items) {
    n++
    let a, b
    try { a = rc.countRefs(await ap.parse('OpenAPI', it.src, { file: it.name })) } catch (e) { console.log(`${it.name}: apidef refuses: ${e.message.slice(0, 80)}`); continue }
    const res = oa.resolve(oa.parse(it.src), { compat: 'apidef', ...(process.env.CUT ? { cycles: 'cut' } : {}) })
    b = countFromProvenance(res.provenance, oa.parse(it.src), res.tree)
    if (canon(a) === canon(b)) { same++; continue }
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])
    console.log(`${it.name}: DIFFERS on ${keys.length}: ` + keys.slice(0, 4).map((k) => `${k} apidef=${a[k]} prov=${b[k]}`).join('; '))
  }
  console.log(`${n} definitions, ${same} identical`)
})()
