/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/worker.cjs: one document, in its own process.
//
// sweep.cjs forks this with the document's path and `fast` or `nofast`,
// with a heap limit, and sends it nothing. Each phase's result goes back
// by IPC as soon as it is known (see examine.cjs), so a timeout or a
// crash keeps the phases already done. Every send is awaited before the
// process exits, since process.exit can drop queued messages.
//
//   node tools/corpus/worker.cjs <file> [fast|nofast]    (by sweep.cjs)

const Fs = require('node:fs')
const Path = require('node:path')
const E = require('./examine.cjs')

const pending = []
const send = (phase, data) => { if (process.send) pending.push(new Promise((ok) => process.send({ phase, data }, ok))) }
const flush = () => Promise.all(pending)

function main() {
  const file = process.argv[2]
  const fast = 'nofast' !== process.argv[3]
  const text = Fs.readFileSync(file, 'utf8')
  E.examine(text, { ext: Path.extname(file), fast, send })
}

try { main(); flush().then(() => process.exit(0)) } catch (e) { send('crash', E.errInfo(e)); flush().then(() => process.exit(1)) }
