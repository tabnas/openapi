/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-gate/model.cjs: apidef's pipeline on one definition, to the
// built model with the generate step off, written as one JSON object
// holding the run's `ok` and `steps`, the guide and the API model. From
// E9's prototype (docs/design/prototype/e9-apidef-swap/model.cjs).
//
// tools/apidef-gate.cjs runs it, once per definition and side:
//
//   node model.cjs <apidef ts/ folder> <definition> <out.json> <scratch folder>
//
// The scratch folder must be empty or absent; the definition is copied into
// it, where apidef reads it, and apidef's guide is written there. If the
// pipeline throws, the output is `{"error": <first line of its message>}`,
// so that both sides failing the same way still compare.

const Fs = require('node:fs')
const Path = require('node:path')

async function model(tsdir, defFile, out, scratch) {
  const { ApiDef } = require(Path.join(tsdir, 'dist', 'apidef.js'))
  const base = Path.basename(defFile)
  const name = base.replace(/\.(json|ya?ml)$/, '').replace(/[^a-z0-9]/gi, '')
  const folder = Path.join(scratch, 'work')
  Fs.mkdirSync(Path.join(folder, 'guide'), { recursive: true })
  Fs.mkdirSync(Path.join(scratch, 'def'), { recursive: true })
  Fs.copyFileSync(defFile, Path.join(scratch, 'def', base))
  Fs.writeFileSync(
    Path.join(folder, 'guide', 'guide.aontu'),
    '@"' + Path.join(tsdir, 'model', 'guide.aontu') + '"\n@"./base-guide.aontu"\n',
  )
  let text
  try {
    const build = await ApiDef.makeBuild({ folder })
    const step = { parse: true, guide: true, transformers: true, builders: true, generate: false }
    const res = await build(
      { name, def: base },
      { spec: { base: folder, buildargs: { apidef: { ctrl: { step } } } } },
      {},
    )
    text = JSON.stringify({ ok: res.ok, steps: res.steps, guide: res.guide, apimodel: res.apimodel })
  } catch (err) {
    text = JSON.stringify({ error: String(err?.message ?? err).split('\n')[0] })
  }
  Fs.writeFileSync(out, text)
}

if (require.main === module) {
  const [tsdir, defFile, out, scratch] = process.argv.slice(2)
  model(tsdir, defFile, out, scratch).then(
    () => process.exit(0),
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
