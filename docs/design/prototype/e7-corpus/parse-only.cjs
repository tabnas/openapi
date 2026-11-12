// Parse one file with @tabnas/openapi alone (no reference parser in the process),
// then resolve; report time and peak RSS, with a heartbeat every 10s.
const Fs = require('node:fs')
const O = require(process.env.OPENAPI_DIST || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const t0 = Date.now()
const hb = setInterval(() => console.log(`parse-only: ${Math.round((Date.now() - t0) / 1000)}s, rss ${Math.round(process.memoryUsage().rss / 1048576)}MiB (percentage unknown)`), 10000)
const text = Fs.readFileSync(process.argv[2], 'utf8')
setImmediate(() => {
  let t = Date.now(); const tree = O.parse(text); const pm = Date.now() - t
  const prss = process.resourceUsage().maxRSS
  t = Date.now(); let rs; try { const r = O.resolve(tree); rs = { ms: Date.now() - t, sites: r.provenance.length, unresolved: r.unresolved.length, cuts: r.cuts.length } } catch (e) { rs = { err: e.code ?? String(e.message).slice(0, 200), ms: Date.now() - t } }
  clearInterval(hb)
  console.log(JSON.stringify({ file: process.argv[2], bytes: text.length, parseMs: pm, maxRSSMiBAfterParse: Math.round(prss / 1024), resolve: rs, maxRSSMiB: Math.round(process.resourceUsage().maxRSS / 1024) }))
})
