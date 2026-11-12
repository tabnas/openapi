// For each document: apidef's pipeline output (guide + apimodel) from the
// document as written, against its output from the same document re-read by
// the reference YAML parser (core schema) and handed over as JSON text.
// If the two are equal, what apidef's reader gets wrong never reaches its output.
//
// usage: node model-compare.cjs <manifest.jsonl> <out.jsonl> [--jobs 3] [--max-bytes 4194304]
//
// APIDEF_TS: the ts/ folder of an apidef checkout, built, with its dependencies installed.
// YAML_REF:  the npm `yaml` package, the reference parser (installed in a scratch folder).
const Fs = require('node:fs'), Path = require('node:path'), Os = require('node:os')
const { spawn } = require('node:child_process')
const YAML = require(process.env.YAML_REF || 'yaml')
const TSDIR = process.env.APIDEF_TS
if (!TSDIR) { console.error('set APIDEF_TS to the ts/ folder of a built apidef checkout'); process.exit(2) }
const MODEL = Path.join(__dirname, '..', 'e9-apidef-swap', 'model.cjs')
const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return -1 === i ? d : args[i + 1] }
const JOBS = Number(opt('--jobs', 3)), MAX = Number(opt('--max-bytes', 4 * 1024 * 1024))
const [manifest, outFile] = args
const all = Fs.readFileSync(manifest, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.size <= MAX)
const done = new Set(Fs.existsSync(outFile) ? Fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : [])
const todo = all.filter((r) => !done.has(r.id))
const out = Fs.openSync(outFile, 'a')
let finished = 0, differ = 0, failed = 0, outDiffer = 0
const t0 = Date.now()
const tick = setInterval(() => console.log(`model-compare: ${finished} of ${todo.length} (${(100 * finished / Math.max(1, todo.length)).toFixed(0)}%), ${Math.round((Date.now() - t0) / 1000)}s, ${differ} differ somewhere, ${outDiffer} differ in apidef's output, ${failed} could not be compared`), 15000)

const runModel = (file, outJson) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--max-old-space-size=4096', MODEL, TSDIR, file, outJson], { cwd: TSDIR, stdio: 'ignore' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
  child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
})

async function one(rec) {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'mc-'))
  const res = { id: rec.id, path: rec.path, size: rec.size }
  try {
    const text = Fs.readFileSync(rec.path, 'utf8')
    const base = Path.basename(rec.path)
    Fs.mkdirSync(dir + '/a'); Fs.mkdirSync(dir + '/b')
    Fs.writeFileSync(dir + '/a/' + base, text)
    const doc = YAML.parseDocument(text, { version: '1.2', schema: 'core', merge: false, uniqueKeys: false })
    Fs.writeFileSync(dir + '/b/' + base, JSON.stringify(doc.toJS({ maxAliasCount: -1 })))
    const ra = await runModel(dir + '/a/' + base, dir + '/a.json')
    const rb = await runModel(dir + '/b/' + base, dir + '/b.json')
    const read = (f) => { try { return Fs.readFileSync(f, 'utf8') } catch { return null } }
    const a = read(dir + '/a.json'), b = read(dir + '/b.json')
    res.a = null === a ? { none: ra } : { bytes: a.length, error: a.startsWith('{"error"') ? a.slice(0, 200) : undefined }
    res.b = null === b ? { none: rb } : { bytes: b.length, error: b.startsWith('{"error"') ? b.slice(0, 200) : undefined }
    if (null === a || null === b || res.a.error || res.b.error) { res.compared = false; failed++ }
    else {
      res.compared = true
      res.equal = a === b
      if (!res.equal) {
        differ++
        const ja = JSON.parse(a), jb = JSON.parse(b)
        // The guide carries copies of the definition under keys ending in `$`
        // (paths$[].def and the like). Those are the input, not apidef's
        // output, so the comparison that matters leaves them out.
        const core = (v) => Array.isArray(v) ? v.map(core) : v && 'object' === typeof v
          ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.endsWith('$')).map(([k, x]) => [k, core(x)])) : v
        const ga = core(ja.guide), gb = core(jb.guide)
        res.guideEqual = JSON.stringify(ja.guide) === JSON.stringify(jb.guide)
        res.guideCoreEqual = JSON.stringify(ga) === JSON.stringify(gb)
        res.modelEqual = JSON.stringify(ja.apimodel) === JSON.stringify(jb.apimodel)
        res.outputEqual = res.guideCoreEqual && res.modelEqual
        if (!res.outputEqual) outDiffer++
        // the first place the two outputs part, as a rough path
        const first = (x, y, p) => {
          if (x === y) return null
          if (null === x || null === y || 'object' !== typeof x || 'object' !== typeof y) return { at: p, a: JSON.stringify(x)?.slice(0, 80), b: JSON.stringify(y)?.slice(0, 80) }
          for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = first(x[k], y[k], p + '/' + k); if (d) return d }
          return null
        }
        res.first = res.outputEqual ? null : (first(ja.apimodel, jb.apimodel, '/apimodel') || first(ga, gb, '/guide'))
      }
    }
  } catch (e) { res.compared = false; res.threw = String(e.message).split('\n')[0].slice(0, 200); failed++ }
  finally { Fs.rmSync(dir, { recursive: true, force: true }) }
  Fs.writeSync(out, JSON.stringify(res) + '\n'); finished++
}

;(async () => {
  console.log(`model-compare: ${all.length} documents within ${MAX} bytes, ${done.size} already done, ${todo.length} to run, ${JOBS} jobs`)
  const queue = todo.slice()
  await Promise.all(Array.from({ length: JOBS }, async () => { while (queue.length) await one(queue.shift()) }))
  clearInterval(tick)
  console.log(`model-compare: done, ${finished} run, ${differ} differ somewhere, ${outDiffer} differ in apidef's output, ${failed} could not be compared, ${Math.round((Date.now() - t0) / 1000)}s`)
})()
