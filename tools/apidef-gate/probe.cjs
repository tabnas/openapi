/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-gate/probe.cjs: which copies of the `@tabnas` packages a
// built apidef really loads. It resolves `@tabnas/openapi` from apidef's
// `ts/dist`, runs apidef's exported `parse` on one OpenAPI description,
// and then reads Node's module cache: every `@tabnas` package with a file
// loaded, by real path and version, and whether any file of this
// repository's `ts/` was loaded at all, which is what says that apidef
// imports this package rather than only being able to find it.
//
// tools/apidef-gate.cjs runs it in a process of its own:
//
//   node probe.cjs <apidef ts/ folder> <this repository's ts/ folder> <description>
//
// It prints one JSON object.

const Fs = require('node:fs')
const Path = require('node:path')

// The folder holding a module's package.json, walking up from a file.
function packageRoot(file) {
  let dir = Path.dirname(file)
  while (dir !== Path.dirname(dir)) {
    const pkg = Path.join(dir, 'package.json')
    if (Fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(Fs.readFileSync(pkg, 'utf8'))
        if (json.name) return { dir, name: json.name, version: json.version }
      } catch {
        // A package.json that does not read is not a package root.
      }
    }
    dir = Path.dirname(dir)
  }
  return null
}

async function probe(tsdir, openapiTs, defFile) {
  const out = { resolved: null, resolveError: null, parsed: null, parseError: null, loaded: [] }
  const dist = Path.join(tsdir, 'dist')
  try {
    out.resolved = Fs.realpathSync(
      Path.dirname(require.resolve('@tabnas/openapi/package.json', { paths: [dist] })),
    )
  } catch (err) {
    out.resolveError = String(err?.message ?? err).split('\n')[0]
  }

  try {
    const { parse } = require(Path.join(dist, 'apidef.js'))
    const def = await parse('OpenAPI', Fs.readFileSync(defFile, 'utf8'), { file: defFile })
    out.parsed = { paths: Object.keys(def?.paths ?? {}).length }
  } catch (err) {
    out.parseError = String(err?.message ?? err).split('\n')[0]
  }

  const openapiReal = Fs.realpathSync(openapiTs) + Path.sep
  const ownModules = openapiReal + 'node_modules' + Path.sep
  const roots = new Map()
  let ownFiles = 0
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(openapiReal) && !file.startsWith(ownModules)) ownFiles++
    if (!file.includes(Path.sep + '@tabnas' + Path.sep) && !file.startsWith(openapiReal)) continue
    const root = packageRoot(file)
    if (null == root || !root.name.startsWith('@tabnas/')) continue
    roots.set(root.dir, root)
  }
  out.importsOpenapi = 0 < ownFiles
  out.loaded = [...roots.values()].sort((a, b) =>
    a.name === b.name ? a.dir.localeCompare(b.dir) : a.name.localeCompare(b.name),
  )
  return out
}

if (require.main === module) {
  const [tsdir, openapiTs, defFile] = process.argv.slice(2)
  probe(tsdir, openapiTs, defFile).then(
    (out) => {
      process.stdout.write(JSON.stringify(out) + '\n')
      process.exit(0)
    },
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
