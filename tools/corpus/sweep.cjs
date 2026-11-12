#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/sweep.cjs: the corpus sweep, and its comparison with the ledger.
//
// It checks that every source of sources.json is fetched at its pinned
// commit (fetch.cjs, or --fetch here), lists the corpus's documents, and
// runs worker.cjs once per distinct document in a fresh process with a
// heap limit and a time limit per phase. Each document's record is
// appended to <out>/results.jsonl as one JSON line, so a stopped run
// resumes where it stopped. A progress line, with a count and a
// percentage, comes at least every 15 seconds.
//
// When every document has a record it prints the figures, then compares
// the ledger and figures of this run with the committed ones,
// test/corpus/ledger.tsv and test/corpus/baseline.json, says which rows
// and which figures moved, and ends non-zero if any did. --write rewrites
// both files from the run instead. test/corpus/accepted.tsv, the rows a
// person has judged not to be this package's defect, is read and never
// written: an entry that matches no row of the run is named, and ends
// the sweep non-zero; --write then writes nothing.
//
// Run from anywhere, under the Node version `engines` in ts/package.json
// names, after `npm run build` in ts/. The whole corpus takes about 26
// minutes at three jobs:
//
//   node tools/corpus/sweep.cjs [--fetch] [--out <dir>] [--jobs 3]
//     [--phase-ms 120000] [--doc-ms 900000] [--heap-mb 4096]
//     [--only <regex on source/path>] [--nofast] [--retry-failed]
//     [--write] [--no-compare]
//
// --out        where the manifest, run.json and results.jsonl go (default .corpus/run)
// --only       sweep only the documents whose `source/path` matches; no comparison
// --nofast     send JSON text to the grammar too (`fast: false` on every parse)
// --retry-failed  run again each document whose last record did not finish
// --write      rewrite the ledger and the baseline from this run
// --no-compare stop after the figures
//
// The package under test is ts/dist/openapi.js unless OPENAPI_DIST names
// another; CORPUS_DIR moves the checkouts (default .corpus/src).

const Fs = require('node:fs')
const Path = require('node:path')
const { fork, spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const S = require('./sources.cjs')
const L = require('./ledger.cjs')
const A = require('./analyze.cjs')

const ROOT = S.ROOT
const LEDGER = Path.join(ROOT, 'test', 'corpus', 'ledger.tsv')
const BASELINE = Path.join(ROOT, 'test', 'corpus', 'baseline.json')
const ACCEPTED = Path.join(ROOT, 'test', 'corpus', 'accepted.tsv')
const WORKER = Path.join(__dirname, 'worker.cjs')
const PROGRESS_MS = 15000
const BIG = 4 * 1024 * 1024

function options(argv) {
  const args = argv.slice(2)
  const known = new Set(['--fetch', '--out', '--jobs', '--phase-ms', '--doc-ms', '--heap-mb', '--only', '--nofast', '--retry-failed', '--write', '--no-compare', '--help'])
  const takes = new Set(['--out', '--jobs', '--phase-ms', '--doc-ms', '--heap-mb', '--only'])
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`unknown argument ${args[i]}; see the header of ${__filename}`)
    if (takes.has(args[i])) { if (undefined === args[i + 1]) throw new Error(`${args[i]} needs a value`); i++ }
  }
  const opt = (name, dflt) => { const i = args.indexOf(name); return -1 === i ? dflt : args[i + 1] }
  const o = {
    help: args.includes('--help'),
    fetch: args.includes('--fetch'),
    out: Path.resolve(opt('--out', Path.join(ROOT, '.corpus', 'run'))),
    jobs: Number(opt('--jobs', 3)),
    phaseMs: Number(opt('--phase-ms', 120000)),
    docMs: Number(opt('--doc-ms', 900000)),
    heapMb: Number(opt('--heap-mb', 4096)),
    only: opt('--only', null),
    nofast: args.includes('--nofast'),
    retryFailed: args.includes('--retry-failed'),
    write: args.includes('--write'),
    compare: !args.includes('--no-compare'),
  }
  for (const k of ['jobs', 'phaseMs', 'docMs', 'heapMb']) if (!(o[k] > 0)) throw new Error(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} must be a positive number`)
  if (o.write && null != o.only) throw new Error('--write needs the whole corpus; it cannot be used with --only')
  return o
}

// The version of the package `name` as `req` resolves it. A package whose
// `exports` hides its package.json is found from its entry point upward.
function versionOf(req, name) {
  try { return req(name + '/package.json').version } catch {}
  let dir
  try { dir = Path.dirname(req.resolve(name)) } catch { return 'not found' }
  for (; dir !== Path.dirname(dir); dir = Path.dirname(dir)) {
    const f = Path.join(dir, 'package.json')
    if (!Fs.existsSync(f)) continue
    const p = JSON.parse(Fs.readFileSync(f, 'utf8'))
    if (p.name === name) return p.version
  }
  return 'not found'
}

// What the run measures with: a different value of any of these makes
// the figures of two runs incomparable, so it is recorded with them.
function environmentOf(o) {
  const dist = Path.resolve(process.env.OPENAPI_DIST || Path.join(ROOT, 'ts', 'dist', 'openapi.js'))
  const pkgFile = Path.join(Path.dirname(dist), '..', 'package.json')
  const pkg = JSON.parse(Fs.readFileSync(pkgFile, 'utf8'))
  const req = createRequire(dist)
  const deps = {}
  for (const name of Object.keys(pkg.peerDependencies ?? pkg.dependencies ?? {}).sort()) deps[name] = versionOf(req, name)
  const tsReq = createRequire(Path.join(ROOT, 'ts', 'package.json'))
  return {
    node: Number(process.versions.node.split('.')[0]),
    package: { name: pkg.name, version: pkg.version },
    dependencies: deps,
    reference: { yaml: versionOf(tsReq, 'yaml') },
    options: { parse: o.nofast ? 'nofast' : 'fast', heapMiB: o.heapMb },
  }
}

const secs = (ms) => Math.round(ms / 1000) + 's'

function ensureSources(sources, o) {
  const missing = sources.filter((s) => !S.isCurrent(s))
  if (!missing.length) return
  if (!o.fetch) {
    console.error(`sweep: ${missing.length} of ${sources.length} sources are not fetched at their pinned commits: ${missing.map((s) => s.name).join(', ')}`)
    console.error(`sweep: fetch them with \`node ${Path.relative(process.cwd(), Path.join(__dirname, 'fetch.cjs'))}\`, or run this with --fetch`)
    process.exit(2)
  }
  const r = spawnSync(process.execPath, [Path.join(__dirname, 'fetch.cjs')], { stdio: 'inherit' })
  if (0 !== r.status) { console.error('sweep: the fetch failed'); process.exit(2) }
}

function buildManifest(sources, o) {
  console.log(`sweep: listing the documents of ${sources.length} sources`)
  let last = Date.now()
  const recs = S.manifest(sources, S.corpusDir(),
    (s, i, n) => console.log(`sweep: listing ${i + 1} of ${sources.length} sources: ${s.name}, ${n} files`),
    (k) => { if (Date.now() - last > PROGRESS_MS) { last = Date.now(); console.log(`sweep: listing, ${k} files read (percentage unknown)`) } })
  const problems = S.countCheck(sources, recs)
  if (problems.length) {
    for (const p of problems) console.error('sweep: ' + p)
    console.error('sweep: the checkouts do not hold the pinned corpus; run fetch.cjs again')
    process.exit(2)
  }
  Fs.mkdirSync(o.out, { recursive: true })
  Fs.writeFileSync(Path.join(o.out, 'manifest.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return recs
}

// A results file belongs to one environment. Resuming it with another
// would mix two packages' records in one set of figures.
function claimOut(o, env) {
  const file = Path.join(o.out, 'run.json')
  if (Fs.existsSync(file)) {
    const was = JSON.parse(Fs.readFileSync(file, 'utf8'))
    const d = A.compareBaseline({ environment: was }, { environment: env })
    if (!d.same) {
      for (const l of d.environment) console.error('sweep: ' + l)
      console.error(`sweep: ${o.out} holds a run made with the environment above; use another --out, or delete that folder to start again`)
      process.exit(2)
    }
  } else Fs.writeFileSync(file, JSON.stringify(env, null, 2) + '\n')
}

function runAll(todo, o, resultsFile) {
  const total = todo.length
  let finished = 0, running = 0, bigRunning = 0, failed = 0
  const started = Date.now()
  const out = Fs.openSync(resultsFile, 'a')
  const active = new Map()
  const progress = () => {
    const el = Date.now() - started
    const eta = finished ? ', about ' + secs(((total - finished) * el) / finished) + ' left' : ''
    const cur = [...active.values()].map((a) => `${a.rec.source}/${a.rec.path}:${a.phase}:${secs(Date.now() - a.t0)}`).join(' ')
    console.log(`sweep: ${finished} of ${total} (${total ? ((100 * finished) / total).toFixed(1) : 100}%), ${secs(el)} elapsed${eta}, ${failed} did not finish; running ${cur || 'nothing'}`)
  }
  const ticker = setInterval(progress, PROGRESS_MS)

  const run = (rec) => new Promise((resolve) => {
    const result = { id: rec.id, source: rec.source, path: rec.path, size: rec.size }
    const t0 = Date.now()
    const child = fork(WORKER, [rec.file, o.nofast ? 'nofast' : 'fast'], { execArgv: [`--max-old-space-size=${o.heapMb}`], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const a = { rec, phase: 'start', t0 }
    active.set(rec.id, a)
    let stderr = '', oom = false
    child.stderr.on('data', (d) => {
      const s = String(d)
      if (/heap out of memory|JavaScript heap/i.test(s)) oom = true
      stderr = (stderr + s).slice(-4000)
    })
    let timer
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { result.timeout = a.phase; child.kill('SIGKILL') }, o.phaseMs) }
    const docTimer = setTimeout(() => { result.timeout = 'document:' + a.phase; child.kill('SIGKILL') }, o.docMs)
    arm()
    child.on('message', (m) => { result[m.phase] = m.data; a.phase = 'after-' + m.phase; arm() })
    // 'close', not 'exit': 'exit' can come before the last IPC messages
    // are delivered, and the record would then lose its last phases.
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(docTimer)
      active.delete(rec.id)
      result.wallMs = Date.now() - t0
      if (!result.done) { result.exit = { code, signal, oom, stderr: stderr.slice(-800) }; failed++ }
      Fs.writeSync(out, JSON.stringify(result) + '\n')
      finished++
      resolve()
    })
  })

  // The large documents last, so the bulk reports early; one large one at
  // a time, and the largest alone.
  const queue = todo.slice().sort((x, y) => (x.size > BIG) - (y.size > BIG))
  return new Promise((done) => {
    const pump = () => {
      if (0 === queue.length && 0 === running) { clearInterval(ticker); progress(); Fs.closeSync(out); return done() }
      while (running < o.jobs && queue.length) {
        const rec = queue[0]
        const big = rec.size > BIG
        if (big && bigRunning > 0) break
        if (big && running > 0 && rec.size > 16 * 1024 * 1024) break
        queue.shift(); running++; if (big) bigRunning++
        run(rec).then(() => { running--; if (big) bigRunning--; pump() })
      }
    }
    progress()
    pump()
  })
}

function compareWithCommitted(records, baseline) {
  const lines = []
  if (!Fs.existsSync(LEDGER) || !Fs.existsSync(BASELINE)) {
    console.log(`sweep: there is no committed ledger or baseline (${Path.relative(ROOT, LEDGER)}, ${Path.relative(ROOT, BASELINE)}); run with --write to make them`)
    return false
  }
  const rows = L.ledgerOf(records)
  const lc = L.compareLedger(L.parseLedger(Fs.readFileSync(LEDGER, 'utf8')), rows)
  const bc = A.compareBaseline(JSON.parse(Fs.readFileSync(BASELINE, 'utf8')), baseline)
  lines.push(...bc.environment.map((l) => 'sweep: environment: ' + l), ...lc.lines, ...bc.figures.map((l) => 'baseline: figure moved: ' + l))
  if (!lines.length) {
    console.log(`sweep: the ledger (${rows.length} rows) and the baseline are as committed`)
    return true
  }
  for (const l of lines) console.log(l)
  console.log(`sweep: ${lc.added.length} ledger rows added, ${lc.removed.length} removed, ${lc.changed.length} changed; ${bc.figures.length} figures moved${bc.environment.length ? ', and the environment differs from the baseline\'s' : ''}`)
  console.log('sweep: a row removed or a figure that improves is a repair, a row added is a regression; when every change is meant, accept them with --write and commit the ledger with the change that moved it')
  return false
}

async function main() {
  const o = options(process.argv)
  if (o.help) { console.log(Fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); return 0 }
  const engines = JSON.parse(Fs.readFileSync(Path.join(ROOT, 'ts', 'package.json'), 'utf8')).engines?.node ?? ''
  const floor = Number((engines.match(/(\d+)/) ?? [])[1])
  if (floor && Number(process.versions.node.split('.')[0]) < floor) console.log(`sweep: warning: Node ${process.versions.node} is older than the ${engines} that ts/package.json names; the figures may differ from the baseline's`)
  const sources = S.loadSources()
  ensureSources(sources, o)
  const env = environmentOf(o)
  const manifest = buildManifest(sources, o)
  claimOut(o, env)
  const only = null == o.only ? null : new RegExp(o.only)
  const docs = manifest.filter((r) => !r.dupOf).filter((r) => null == only || only.test(r.source + '/' + r.path))
  const resultsFile = Path.join(o.out, 'results.jsonl')
  const finished = new Set()
  for (const r of L.readRecords(resultsFile)) {
    if (o.retryFailed && !r.done) finished.delete(r.id)
    else finished.add(r.id)
  }
  const todo = docs.filter((r) => !finished.has(r.id))
  console.log(`sweep: ${docs.length} documents, ${docs.length - todo.length} already done, ${todo.length} to run, ${o.jobs} jobs, heap ${o.heapMb} MB, ${secs(o.phaseMs)} a phase; results in ${resultsFile}`)
  if (todo.length) await runAll(todo, o, resultsFile)

  const ids = new Set(docs.map((r) => r.id))
  const records = L.lastOf(L.readRecords(resultsFile)).filter((r) => ids.has(r.id))
  if (null != o.only) {
    console.log('\n' + A.summary(A.baselineOf(records, env)) + '\n')
    console.log('sweep: a partial sweep (--only), so no comparison with the ledger')
    return 0
  }
  const rows = L.ledgerOf(records)
  // A person writes accepted.tsv, so the sweep reads it and never writes it.
  const accepted = Fs.existsSync(ACCEPTED) ? L.parseAccepted(Fs.readFileSync(ACCEPTED, 'utf8')) : []
  const acc = L.checkAccepted(accepted, rows)
  const baseline = A.baselineOf(records, env, acc)
  console.log('\n' + A.summary(baseline) + '\n')
  if (records.length !== docs.length) { console.log(`sweep: ${docs.length - records.length} documents have no record; run again to finish`); return 1 }
  for (const l of acc.lines) console.log(l)
  if (o.write && acc.stranded.length) {
    console.log(`sweep: wrote nothing: ${acc.stranded.length} entries of ${Path.relative(ROOT, ACCEPTED)} match no row, and the baseline would count them wrongly; correct that file, then run --write again`)
    return 1
  }
  if (o.write) {
    Fs.mkdirSync(Path.dirname(LEDGER), { recursive: true })
    Fs.writeFileSync(LEDGER, L.formatLedger(rows))
    Fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
    console.log(`sweep: wrote ${Path.relative(ROOT, LEDGER)} (${rows.length} rows) and ${Path.relative(ROOT, BASELINE)}`)
    return 0
  }
  if (!o.compare) return acc.stranded.length ? 1 : 0
  return compareWithCommitted(records, baseline) && !acc.stranded.length ? 0 : 1
}

main().then((code) => { process.exitCode = code }, (e) => { console.error('sweep: ' + e.message); process.exitCode = 2 })
