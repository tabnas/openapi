/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/worker.cjs: corpus documents, one at a time, in a
// process of its own.
//
// apidef-preset.cjs forks this with the path of apidef's parse.js (the
// one it found and checked) and this package's build, and sends it
// { id, file } messages. For each it reads the file, compares the two
// resolvers (compare.cjs) and sends back { id, rec }, the record cut down
// to what the summary needs. A document that runs past the parent's limit
// or crashes this process is the parent's to report.
//
//   node tools/apidef-preset/worker.cjs <apidef parse.js> <openapi.js> [<options as JSON>]   (by apidef-preset.cjs)

const Fs = require('node:fs')
const { loadFile } = require('./apidef.cjs')
const { compareText } = require('./compare.cjs')

const A = loadFile(process.argv[2])
const O = require(process.argv[3])
const options = null == process.argv[4] ? {} : JSON.parse(process.argv[4])

// What crosses back: no trees.
function slim(rec) {
  const out = {
    bytes: rec.bytes, version: rec.version, failed: rec.failed, verdict: rec.verdict,
    graphEqual: rec.graphEqual, cutEqual: rec.cutEqual, sortedEqual: rec.sortedEqual, unfoldedEqual: rec.unfoldedEqual,
    first: rec.first, classes: rec.classes, sites: rec.sites,
  }
  if (rec.differing) {
    const by = {}
    for (const d of rec.differing) by[d.cls] = (by[d.cls] ?? 0) + 1
    out.sitesByClass = by
  }
  return out
}

process.on('message', (msg) => {
  let rec
  try {
    const text = Fs.readFileSync(msg.file, 'utf8')
    rec = slim(compareText(text, { A, O, options }))
  } catch (e) {
    rec = { failed: { stage: 'harness', error: String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ') } }
  }
  process.send({ id: msg.id, rec })
})
process.send({ ready: true })
