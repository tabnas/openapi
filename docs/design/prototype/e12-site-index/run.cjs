#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: today's `resolve` against the prototype built on the site index,
// over the corpus of tools/corpus and apidef's own definitions.
//
//   EXPR_DIST=<expr build with site.written>/ts/dist/expr.js \
//   node run.cjs --out <results.jsonl> [--corpus <run dir>] [--apidef <checkout>]
//                [--jobs n] [--heap-mb n] [--timeout seconds] [--only source,...]
//                [--order document|pointer] [--limit n]
//
// The corpus documents are the ones a finished sweep resolved: the
// manifest and results of `.corpus/run` (or --corpus). apidef's are the
// OpenAPI descriptions in its ts/test/def/, with this repository's
// petstore pair, and those are also compared under the preset.
//
// One record for each document is appended to --out, so a run that is
// stopped goes on where it left off. A status line is printed every 15
// seconds. Exit status: 0 when every document was compared; 1 when one
// failed, ran out of time or memory; 2 on a usage error.

const Fs = require('node:fs')
const Path = require('node:path')
const Child = require('node:child_process')

const ROOT = Path.join(__dirname, '..', '..', '..', '..')

function usage(msg) {
  console.error('run.cjs: ' + msg)
  process.exit(2)
}

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return -1 === i ? fallback : args[i + 1]
}
const OUT = opt('out')
if (null == OUT) usage('--out <results.jsonl> is needed')
const CORPUS = Path.resolve(opt('corpus', Path.join(ROOT, '.corpus', 'run')))
const APIDEF = opt('apidef')
const JOBS = Number(opt('jobs', 3))
const HEAP = Number(opt('heap-mb', 6144))
const TIMEOUT = 1000 * Number(opt('timeout', 900))
const ONLY = null == opt('only') ? null : new Set(opt('only').split(','))
const ORDER = opt('order', 'document')
const LIMIT = Number(opt('limit', Infinity))

// ---- the documents ----

const lines = (file) => Fs.readFileSync(file, 'utf8').split('\n').filter((l) => '' !== l.trim()).map((l) => JSON.parse(l))

function isDescription(file) {
  const text = Fs.readFileSync(file, 'utf8')
  if (/\.json$/i.test(file)) {
    try {
      const v = JSON.parse(text)
      return null != v && 'object' === typeof v && ('openapi' in v || 'swagger' in v)
    } catch {
      return false
    }
  }
  if (/\.ya?ml$/i.test(file)) return /^["']?(openapi|swagger)["']?\s*:/m.test(text)
  return false
}

const docs = []
if (Fs.existsSync(Path.join(CORPUS, 'manifest.jsonl'))) {
  const last = new Map()
  for (const r of lines(Path.join(CORPUS, 'results.jsonl'))) last.set(r.id, r)
  for (const m of lines(Path.join(CORPUS, 'manifest.jsonl'))) {
    if (m.dupOf) continue
    const r = last.get(m.id)
    if (null == r || true !== r.resolve?.ok) continue
    docs.push({ id: m.id, set: 'corpus', source: m.source, path: m.path, file: m.file, size: m.size, sweepSites: r.resolve.sites })
  }
}
if (null != APIDEF) {
  const dir = Path.join(Path.resolve(APIDEF), 'ts', 'test', 'def')
  for (const name of Fs.readdirSync(dir).sort()) {
    const file = Path.join(dir, name)
    if (name.endsWith('.full.json') || !Fs.statSync(file).isFile() || !isDescription(file)) continue
    docs.push({ id: 'apidef:' + name, set: 'apidef', source: 'apidef', path: 'ts/test/def/' + name, file, size: Fs.statSync(file).size, preset: true })
  }
  for (const name of ['petstore.json', 'petstore.yaml']) {
    const file = Path.join(ROOT, 'test', 'petstore', name)
    docs.push({ id: 'petstore:' + name, set: 'apidef', source: 'petstore', path: 'test/petstore/' + name, file, size: Fs.statSync(file).size, preset: true })
  }
}

let todo = docs.filter((d) => null == ONLY || ONLY.has(d.source))
const done = new Set()
if (Fs.existsSync(OUT)) for (const r of lines(OUT)) done.add(r.id)
todo = todo.filter((d) => !done.has(d.id)).slice(0, LIMIT)
// The largest first, so that the longest documents do not all end the run.
todo.sort((a, b) => b.size - a.size)

// ---- the run ----

const total = todo.length
const started = Date.now()
let finished = 0
let differ = 0
let failed = 0
let sites = 0
const secs = () => ((Date.now() - started) / 1000).toFixed(0) + 's'
const status = () =>
  `e12: ${finished} of ${total} documents (${0 < total ? Math.floor((100 * finished) / total) : 100}%), ` +
  `${sites} sites, ${differ} with a difference, ${failed} failed, ${secs()}`

console.log(`e12: ${docs.length} documents in all, ${done.size} already in ${OUT}, ${total} to run; ` +
  `${JOBS} workers, order ${ORDER}`)
const timer = setInterval(() => console.log(status()), 15000)

const out = Fs.openSync(OUT, 'a')
const write = (doc, rec) => {
  const { file, ...meta } = doc
  Fs.writeSync(out, JSON.stringify({ ...meta, ...rec }) + '\n')
  finished++
  if (rec.failed || rec.timeout || rec.crashed) failed++
  else {
    sites += rec.sites ?? 0
    const eq = (d) => null == d || true === d.equal
    if (!(eq(rec.index) && eq(rec.full) && eq(rec.keep) && eq(rec.preset))) differ++
  }
}

let next = 0
let live = 0

function startWorker() {
  if (next >= todo.length) return
  live++
  const child = Child.fork(Path.join(__dirname, 'worker.cjs'), [], {
    execArgv: ['--max-old-space-size=' + HEAP],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  let doc = null
  let clock = null
  const give = () => {
    if (next >= todo.length) {
      child.disconnect()
      return
    }
    doc = todo[next++]
    clock = setTimeout(() => {
      const d = doc
      doc = null
      write(d, { timeout: TIMEOUT / 1000 })
      child.kill('SIGKILL')
    }, TIMEOUT)
    child.send({ id: doc.id, file: doc.file, preset: doc.preset, order: ORDER })
  }
  child.on('message', (msg) => {
    if (msg.ready) return give()
    clearTimeout(clock)
    const d = doc
    doc = null
    write(d, msg)
    give()
  })
  child.on('exit', (code, signal) => {
    clearTimeout(clock)
    live--
    if (null != doc) {
      write(doc, { crashed: `exit ${code} ${signal ?? ''}`.trim() })
      doc = null
    }
    if (next < todo.length) startWorker()
    else if (0 === live) finish()
  })
}

function finish() {
  clearInterval(timer)
  Fs.closeSync(out)
  console.log(status())
  process.exit(0 < failed ? 1 : 0)
}

if (0 === total) finish()
for (let i = 0; i < Math.min(JOBS, total); i++) startWorker()
