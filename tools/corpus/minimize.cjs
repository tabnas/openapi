#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/minimize.cjs: cut a failing document down to the smallest
// text that still fails the same way.
//
// Line-based delta debugging. It removes chunks of lines while the
// predicate still holds, and prints what is left. The predicate:
//
//   parse-error <code> [token]  the reference parser accepts the text as one
//                               YAML map, and the package refuses it with
//                               <code> (and, if given, at a token with that source)
//   mismatch <class-prefix>     both read it, and a class of difference
//                               starts with <class-prefix> (see examine.cjs)
//   timeout <ms>                the reference accepts it, and the package
//                               takes more than <ms> to parse it
//
//   node tools/corpus/minimize.cjs <file> <predicate> <argument> [token] > small.yaml
//
// The search runs in a process of its own, because a parse cannot be
// interrupted to report, and one parse of a large document can take
// longer than any reporting interval. This process prints a status line
// to stderr at least every 15 seconds: the time so far, the candidates
// tried and the lines left. How many candidates remain is not known in
// advance, so the line says that the percentage is unknown. The smallest
// text goes to stdout.

const Fs = require('node:fs')
const { fork } = require('node:child_process')

const MODES = ['parse-error', 'mismatch', 'timeout']
const STATUS_MS = 15000
const secs = (ms) => Math.round(ms / 1000) + 's'

// The search, as the child of `main`. It reports each candidate tried to
// its parent and, at the end, the lines left.
function search(file, mode, arg, tok) {
  const E = require('./examine.cjs')
  const { YAML, O } = E.load()
  // A parent that has gone leaves nobody to search for.
  const say = (m) => {
    if (!process.send) return
    if (!process.connected) process.exit(1)
    process.send(m)
  }

  function refOk(t) {
    try {
      const ds = YAML.parseAllDocuments(t, { version: '1.2', schema: 'core', uniqueKeys: false, merge: true })
      if (!Array.isArray(ds) || 1 !== ds.length || ds[0].errors.length) return null
      const v = ds[0].toJS({ maxAliasCount: -1 })
      return null != v && 'object' === typeof v && !Array.isArray(v) ? { v, d: ds[0] } : null
    } catch { return null }
  }
  function strictRef(t) {
    const d = YAML.parseDocument(t, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false })
    return d.errors.length ? null : { v: d.toJS({ maxAliasCount: -1 }), d }
  }
  function holds(t) {
    if ('parse-error' === mode) {
      if (!refOk(t)) return false
      if (/^ /.test(t)) return false // an indented root is its own class
      try { O.parse(t); return false } catch (e) { return e.code === arg && (null == tok || e.toJSON?.().token?.src === tok) }
    }
    if ('timeout' === mode) {
      if (!refOk(t)) return false
      const s = Date.now()
      try { O.parse(t) } catch {}
      return Date.now() - s > Number(arg)
    }
    const r = strictRef(t)
    if (!r || null == r.v || 'object' !== typeof r.v || Array.isArray(r.v)) return false
    let tab
    try { tab = O.parse(t) } catch { return false }
    return Object.keys(E.groupDiffs(E.compare(r.v, tab), r.d, t)).some((k) => k.startsWith(arg))
  }

  const text = Fs.readFileSync(file, 'utf8')
  let lines = text.split('\n')
  let tried = 0
  say({ lines: lines.length, tried, n: 0, whole: true })
  if (!holds(text)) return null
  let n = 2
  while (lines.length >= 2) {
    const chunk = Math.ceil(lines.length / n)
    let reduced = false
    for (let i = 0; i < lines.length; i += chunk) {
      const cand = [...lines.slice(0, i), ...lines.slice(i + chunk)]
      const kept = holds(cand.join('\n'))
      tried++
      if (kept) { lines = cand; n = Math.max(n - 1, 2); reduced = true }
      say({ lines: lines.length, tried, n })
      if (kept) break
    }
    if (!reduced) { if (n >= lines.length) break; n = Math.min(lines.length, n * 2) }
  }
  return lines.join('\n') + '\n'
}

// The parent: runs the search in a child, and reports while it works.
function main(args) {
  const [file, mode] = args
  if (!file || !MODES.includes(mode)) {
    console.error('usage: node tools/corpus/minimize.cjs <file> parse-error|mismatch|timeout <argument> [token]')
    return Promise.resolve(2)
  }
  return new Promise((resolve) => {
    const started = Date.now()
    let last = { whole: true }
    let result
    const child = fork(__filename, ['--search', ...args], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const status = () => {
      const what = last.whole
        ? 'checking that the predicate holds on the whole file'
        : `${last.tried} candidates tried, ${last.lines} lines left, granularity ${last.n}`
      process.stderr.write(`minimize: ${secs(Date.now() - started)} elapsed, ${what} (percentage unknown)\n`)
    }
    const ticker = setInterval(status, STATUS_MS)
    // The search is this process's to end: a parse does not hear a signal.
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => { child.kill('SIGKILL'); process.exit('SIGINT' === sig ? 130 : 143) })
    }
    child.on('message', (m) => { if ('text' in m) result = m.text; else last = m })
    // 'close', not 'exit': the last message can arrive after 'exit'.
    child.on('close', (code, signal) => {
      clearInterval(ticker)
      if (0 !== code) {
        console.error(`minimize: the search ended ${null == code ? 'on ' + signal : 'with exit ' + code}`)
        return resolve(1)
      }
      if (null == result) {
        console.error('minimize: the predicate does not hold on the whole file')
        return resolve(2)
      }
      process.stderr.write(`minimize: done in ${secs(Date.now() - started)}: ${last.tried ?? 0} candidates tried, ${result.split('\n').length - 1} lines left\n`)
      process.stdout.write(result, () => resolve(0))
    })
  })
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if ('--search' === args[0]) {
    const text = search(...args.slice(1))
    process.send({ text }, () => process.exit(0))
  } else {
    main(args).then((code) => { process.exitCode = code })
  }
}

module.exports = { main, STATUS_MS }
