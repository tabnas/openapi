// model.cjs APIDEF_TS_DIR DEF_FILE OUT_JSON: runs apidef's pipeline to the
// built model (generate off) and writes guide + apimodel as JSON.
const Fs = require('fs'), Path = require('path')
const [tsdir, defFile, out] = process.argv.slice(2)
const { ApiDef } = require(tsdir + '/dist/apidef.js')
const name = Path.basename(defFile).replace(/\.(json|ya?ml)$/, '').replace(/[^a-z0-9]/gi, '')
const root = Fs.mkdtempSync(tsdir + '/test/_cmp-')
const folder = root + '/work'
Fs.mkdirSync(folder + '/guide', { recursive: true }); Fs.mkdirSync(root + '/def')
Fs.copyFileSync(defFile, root + '/def/' + Path.basename(defFile))
Fs.writeFileSync(folder + '/guide/guide.aontu', '@"' + tsdir + '/model/guide.aontu"\n@"./base-guide.aontu"\n')
;(async () => {
  try {
    const build = await ApiDef.makeBuild({ folder })
    const t0 = Date.now()
    const bres = await build({ name, def: Path.basename(defFile) },
      { spec: { base: folder, buildargs: { apidef: { ctrl: { step: { parse: true, guide: true, transformers: true, builders: true, generate: false } } } } } }, {})
    const seen = new WeakSet()
    const safe = JSON.stringify({ ok: bres.ok, steps: bres.steps, guide: bres.guide, apimodel: bres.apimodel }, (k, v) => {
      if (v && 'object' === typeof v) { if (seen.has(v)) { /* shared: keep, JSON copies */ } }
      return v
    })
    Fs.writeFileSync(out, safe)
    Fs.appendFileSync(out + ".sum", `${Path.basename(defFile)}: ok=${bres.ok} steps=${bres.steps} ${Date.now() - t0} ms, ${safe.length} bytes\n`)
  } catch (e) {
    Fs.writeFileSync(out, JSON.stringify({ error: String(e.message).split('\n')[0] }))
    Fs.appendFileSync(out + ".sum", `${Path.basename(defFile)}: ERROR ${String(e.message).split('\n')[0].slice(0, 150)}` + "\n")
  } finally {
    Fs.rmSync(root, { recursive: true, force: true })
  }
})()
