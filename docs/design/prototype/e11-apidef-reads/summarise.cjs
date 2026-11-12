// Summarise model-compare's results against the kinds of reading difference
// the sweep recorded for each document.
// usage: node summarise.cjs <models.jsonl> <sweep results.jsonl>
const Fs = require('node:fs')
const last = (f) => [...new Map(Fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r])).values()]
const M = last(process.argv[2]), S = new Map(last(process.argv[3]).map((r) => [r.id, r]))
const cat = (k) => /yaml11-bool-word|underscore/.test(k) ? 'choice' : /string->null/.test(k) ? 'comment' : /BLOCK_LITERAL/.test(k) ? 'reference parser' : 'layout'
const kindOf = (id) => {
  const s = S.get(id)
  if (!s.parse || !s.parse.ok) return 'refused'
  const ks = new Set(Object.keys(s.compare.classes).map(cat))
  return ks.has('comment') ? 'comment' : ks.has('layout') ? 'layout' : ks.has('reference parser') ? 'reference parser' : 'choice'
}
const where = (first) => {
  const at = first && first.at || ''
  if (/\/ex$|\/ex\//.test(at)) return 'an example value'
  if (/\/info\/servers/.test(at)) return 'a server URL'
  if (/\/info\//.test(at)) return 'info text'
  return 'structure: ' + at.split('/').slice(0, 7).join('/')
}
const rows = {}
const add = (kind, col) => { rows[kind] ??= { documents: 0, 'output equal': 0, 'output differs': 0, 'not compared': 0, where: {} }; rows[kind].documents++; rows[kind][col]++ }
for (const r of M) {
  const kind = kindOf(r.id)
  if (!r.compared) { add(kind, 'not compared'); continue }
  const same = r.equal || r.outputEqual
  add(kind, same ? 'output equal' : 'output differs')
  if (!same) { const w = where(r.first); rows[kind].where[w] = (rows[kind].where[w] || 0) + 1 }
}
let total = { documents: 0, 'output equal': 0, 'output differs': 0, 'not compared': 0 }
for (const [k, v] of Object.entries(rows)) { for (const c of Object.keys(total)) total[c] += v[c]; console.log(k.padEnd(17), JSON.stringify(v)) }
console.log('total'.padEnd(17), JSON.stringify(total))
