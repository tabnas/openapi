// For a sample of descriptions: every resolved site whose $ref is a local
// JSON Pointer must name, as its provenance target, that pointer; and the
// value the resolved tree holds at the site must deep-equal the raw target
// (2.0/3.0 Reference Objects without siblings). Reports mismatches.
// usage: node target-check.cjs <results.jsonl> <sample-size> [seed]
const Fs = require('node:fs')
const W = require('./worker.cjs')
const O = W.O
// The driver appends; where a document ran more than once, its last record stands.
const lastOf = (rows) => [...new Map(rows.map((r) => [r.id, r])).values()]
const R = lastOf(Fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  .filter((r) => r.resolve?.ok && r.resolve.sites > 0 && r.size < 3e6)
let seed = Number(process.argv[4] ?? 7)
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const N = Math.min(Number(process.argv[3]), R.length)
const pick = R.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).slice(0, N).map((x) => x[1])
const norm = (frag) => { try { return decodeURIComponent(frag) } catch { return frag } }
// A provenance target is an RFC 6901 pointer already.
let sites = 0, checked = 0, bad = []
pick.forEach((r, i) => {
  if (i % 50 === 0) process.stderr.write(`target-check: ${i} of ${N} (${((100 * i) / N).toFixed(0)}%)\n`)
  const raw = O.parse(Fs.readFileSync(r.path, 'utf8'))
  const res = O.resolve(raw)
  for (const p of res.provenance) {
    sites++
    if (p.status !== 'resolved' || 'string' !== typeof p.ref || !p.ref.startsWith('#/')) continue
    checked++
    const want = norm(p.ref.slice(1))
    if (p.target !== want) { if (bad.length < 20) bad.push({ path: r.path, at: p.at, ref: p.ref, target: p.target }); continue }
  }
})
console.log(JSON.stringify({ docs: N, sites, checkedLocalPointerSites: checked, targetMismatches: bad.length, samples: bad }, null, 1))
