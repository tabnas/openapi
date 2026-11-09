#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/model-census.cjs: what the object model makes of every `$ref` map
// in real descriptions.
//
// For each file named, it parses the description with the built package
// (ts/dist), reads its version, finds every map that owns a `$ref` member,
// and classifies the map's position. It prints, per file, the number of
// such maps by the kind of position they sit at, and the first few that
// sit in data, so that a change to the model or its inputs shows as a
// change in the census. The plan's acceptance pins Stripe's: 389 of 4062
// maps are data (an extension's value, an example payload, and the like).
//
// The descriptions are not in this repository; fetch them first. Run from
// the repository root after `npm run build` in ts/:
//
//   node tools/model-census.cjs path/to/spec3.json [more files...]

const Fs = require('node:fs')
const Path = require('node:path')

const DIST = Path.join(__dirname, '..', 'ts', 'dist')
const { parse, version } = require(Path.join(DIST, 'openapi.js'))
const { classify } = require(Path.join(DIST, 'model.js'))

// RFC 6901, for the report.
const pointer = (path) =>
  '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')

function census(file) {
  const started = Date.now()
  const tree = parse(Fs.readFileSync(file, 'utf8'))
  const v = version(tree).version
  if ('unknown' === v) throw new Error(`${file}: no version this package reads`)
  const counts = {}
  const data = []
  let total = 0
  // Iterative, so a deep description cannot exhaust the stack here.
  const stack = [[tree, []]]
  while (0 < stack.length) {
    const [node, path] = stack.pop()
    if (Array.isArray(node)) {
      for (let i = node.length - 1; 0 <= i; i--) stack.push([node[i], [...path, i]])
      continue
    }
    if (null == node || 'object' !== typeof node) continue
    if (Object.prototype.hasOwnProperty.call(node, '$ref')) {
      total++
      const slot = classify(v, path)
      const kind = 'object' === slot.kind ? 'object:' + slot.type : slot.kind
      counts[kind] = (counts[kind] ?? 0) + 1
      if ('data' === slot.kind && data.length < 8) data.push(pointer(path))
    }
    const names = Object.keys(node)
    for (let i = names.length - 1; 0 <= i; i--) stack.push([node[names[i]], [...path, names[i]]])
  }
  return { file: Path.basename(file), version: v, total, counts, data, ms: Date.now() - started }
}

function main(files) {
  if (0 === files.length) {
    console.error('usage: node tools/model-census.cjs <description>...')
    return 2
  }
  files.forEach((file, i) => {
    const r = census(file)
    console.log(`census ${i + 1} of ${files.length}: ${r.file}, OpenAPI ${r.version}, ${r.ms} ms`)
    console.log(`  $ref maps: ${r.total}`)
    for (const [kind, n] of Object.entries(r.counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${kind}: ${n}`)
    }
    if (0 < r.data.length) console.log('  first in data: ' + r.data.join(', '))
  })
  return 0
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = { census }
