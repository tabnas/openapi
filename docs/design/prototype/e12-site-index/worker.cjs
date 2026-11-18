/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: one worker of run.cjs. It is sent one document at a time, parses
// it with this package's `parse`, runs every comparison of compare.cjs on
// the raw tree, and sends the record back.

const Fs = require('node:fs')
const C = require('./compare.cjs')

process.on('message', (job) => {
  const rec = { id: job.id }
  try {
    const text = Fs.readFileSync(job.file, 'utf8')
    const t = performance.now()
    let raw
    try {
      raw = C.O.parse(text)
    } catch (e) {
      rec.unread = String(e?.code ?? e?.name ?? 'Error')
    }
    rec.parseMs = performance.now() - t
    if (undefined === rec.unread) Object.assign(rec, C.examine(raw, { preset: true === job.preset, order: job.order }))
  } catch (e) {
    rec.failed = String(e?.code ?? e?.name ?? 'Error') + ': ' + String(e?.message ?? e).split('\n')[0].slice(0, 200)
  }
  process.send(rec)
})

process.send({ ready: true })
