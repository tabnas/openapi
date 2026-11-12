// Parse one file with @tabnas/openapi alone (no reference parser in the
// process), then resolve; report time and peak RSS.
//
// `parse` and `resolve` are synchronous, so a timer in the process that
// runs them cannot fire until they return. The measured work therefore
// runs in a child process, and this one prints a heartbeat every 10 s
// until the child reports.
//
// usage: node parse-only.cjs <file>
const Fs = require('node:fs')
const Path = require('node:path')
const DIST = process.env.OPENAPI_DIST || Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js')
const file = process.argv[2]

if ('measure' === process.env.PARSE_ONLY_ROLE) {
  const O = require(DIST)
  const text = Fs.readFileSync(file, 'utf8')
  let t = Date.now(); const tree = O.parse(text); const pm = Date.now() - t
  const prss = process.resourceUsage().maxRSS
  t = Date.now(); let rs; try { const r = O.resolve(tree); rs = { ms: Date.now() - t, sites: r.provenance.length, unresolved: r.unresolved.length, cuts: r.cuts.length } } catch (e) { rs = { err: e.code ?? String(e.message).slice(0, 200), ms: Date.now() - t } }
  process.send({ file, bytes: text.length, parseMs: pm, maxRSSMiBAfterParse: Math.round(prss / 1024), resolve: rs, maxRSSMiB: Math.round(process.resourceUsage().maxRSS / 1024) })
} else {
  const { fork } = require('node:child_process')
  const t0 = Date.now()
  const child = fork(__filename, [file], { env: { ...process.env, PARSE_ONLY_ROLE: 'measure' }, execArgv: process.execArgv })
  const hb = setInterval(() => console.log(`parse-only: ${Math.round((Date.now() - t0) / 1000)}s elapsed, still measuring (percentage unknown)`), 10000)
  let result
  child.on('message', (m) => { result = m })
  child.on('exit', (code, signal) => {
    clearInterval(hb)
    if (result) return console.log(JSON.stringify(result))
    console.log(JSON.stringify({ file, failed: { code, signal }, wallMs: Date.now() - t0 }))
    process.exitCode = 1
  })
}
