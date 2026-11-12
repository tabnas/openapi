#!/usr/bin/env node
'use strict'
// Sweep driver: runs tools/worker.cjs once per document in the manifest, in
// a fresh process with a heap limit and a per-phase time limit, and appends
// one JSON line per document to the results file. Resumable: documents
// already in the results file are skipped. With --retry-failed, a document
// whose latest record is a worker failure (no `done`) runs again and a new
// record is appended; the analysis scripts read the last record of each id.
//
// usage: node driver.cjs <manifest.jsonl> <results.jsonl> [--jobs 3] [--phase-ms 120000]
//        [--heap-mb 4096] [--only <regex on path>] [--nofast] [--retry-failed]
const Fs = require('node:fs')
const Path = require('node:path')
const { fork } = require('node:child_process')

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return -1 === i ? dflt : args[i + 1] }
const [manifestFile, resultsFile] = args
const JOBS = Number(opt('--jobs', 3))
const PHASE_MS = Number(opt('--phase-ms', 120000))
const DOC_MS = Number(opt('--doc-ms', 900000))
const HEAP_MB = Number(opt('--heap-mb', 4096))
const ONLY = opt('--only', null)
const NOFAST = args.includes('--nofast')
const RETRY_FAILED = args.includes('--retry-failed')
const BIG = 4 * 1024 * 1024
const WORKER = Path.join(__dirname, 'worker.cjs')

const all = Fs.readFileSync(manifestFile, 'utf8').trim().split('\n').map(JSON.parse)
  .filter((r) => !r.dupOf).filter((r) => null == ONLY || new RegExp(ONLY).test(r.path))
const done = new Set()
if (Fs.existsSync(resultsFile)) {
  for (const l of Fs.readFileSync(resultsFile, 'utf8').split('\n')) {
    if (!l) continue
    let r
    try { r = JSON.parse(l) } catch { continue }
    // The last record of an id decides: a later success supersedes a failure.
    if (RETRY_FAILED && !r.done) done.delete(r.id)
    else done.add(r.id)
  }
}
const todo = all.filter((r) => !done.has(r.id))
// big ones last, so the bulk reports early; and at most one big at a time
todo.sort((a, b) => (a.size > BIG) - (b.size > BIG))
const total = todo.length
let finished = 0, running = 0, bigRunning = 0, failed = 0
const started = Date.now()
const out = Fs.openSync(resultsFile, 'a')
const active = new Map()
console.log(`sweep: ${all.length} documents, ${done.size} already done, ${total} to run, ${JOBS} jobs`)

function progress() {
  const el = Math.round((Date.now() - started) / 1000)
  const cur = [...active.values()].map((a) => `${a.rec.id}:${a.phase}:${Math.round((Date.now() - a.t0) / 1000)}s`).join(' ')
  console.log(`sweep: ${finished} of ${total} (${total ? ((100 * finished) / total).toFixed(1) : 100}%), ${el}s elapsed, ${failed} worker failures; running ${cur}`)
}
const ticker = setInterval(progress, 15000)

function run(rec) {
  return new Promise((resolve) => {
    const result = { id: rec.id, source: rec.source, path: rec.path, size: rec.size }
    const t0 = Date.now()
    const child = fork(WORKER, [rec.path, NOFAST ? 'nofast' : 'fast'], { execArgv: [`--max-old-space-size=${HEAP_MB}`], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const a = { rec, phase: 'start', t0 }
    active.set(rec.id, a)
    let stderr = ''
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    let timer
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { result.timeout = a.phase; child.kill('SIGKILL') }, PHASE_MS) }
    const docTimer = setTimeout(() => { result.timeout = 'doc:' + a.phase; child.kill('SIGKILL') }, DOC_MS)
    arm()
    child.on('message', (m) => { result[m.phase] = m.data; a.phase = 'after-' + m.phase; arm() })
    child.on('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(docTimer)
      active.delete(rec.id)
      result.wallMs = Date.now() - t0
      if (!result.done) { result.exit = { code, signal, stderr: stderr.slice(-800) }; failed++ }
      Fs.writeSync(out, JSON.stringify(result) + '\n')
      finished++
      resolve()
    })
  })
}

async function main() {
  const queue = todo.slice()
  await new Promise((resolveAll) => {
    const pump = () => {
      if (0 === queue.length && 0 === running) return resolveAll()
      while (running < JOBS && queue.length) {
        const rec = queue[0]
        const big = rec.size > BIG
        if (big && bigRunning > 0) break
        if (big && running > 0 && rec.size > 16 * 1024 * 1024) break // the largest alone
        queue.shift(); running++; if (big) bigRunning++
        run(rec).then(() => { running--; if (big) bigRunning--; pump() })
      }
    }
    pump()
  })
  clearInterval(ticker)
  progress()
  console.log('sweep: done')
}
main()
