#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset.cjs: the apidef preset, tested against apidef's own
// resolver. It finds every shape of document where `resolve(raw, {
// compat: 'apidef' })` gives a different tree from the resolver inside
// @voxgig/apidef (`addXRefsAndResolve` in its parse stage), groups the
// differences by cause, and finds the smallest document for each cause.
//
// Run from the repository root, under the Node version `engines` in
// ts/package.json names, after `npm run build` in ts/:
//
//   node tools/apidef-preset.cjs <apidef checkout>
//   node tools/apidef-preset.cjs <apidef checkout> --corpus .corpus/src
//   node tools/apidef-preset.cjs <apidef checkout> --ref 3058271 --sets hand
//   node tools/apidef-preset.cjs <apidef checkout> --sets rows --rows test/resolve/apidef-extra.tsv
//   node tools/apidef-preset.cjs <apidef checkout> --sets hand --options '{"refs":"uri"}'
//
// apidef's resolver is loaded from the checkout's built ts/dist/parse.js,
// or with --ref from the ts/dist committed at that commit, and never
// copied (tools/apidef-preset/apidef.cjs). The package under test is
// ts/dist/openapi.js, or the file OPENAPI_DIST names. The checkout is only
// read.
//
// For each document the text is parsed with this package's `parse`, once
// per side, so both resolvers start from the same raw tree. apidef's runs
// as its parse stage runs it, `addXRefsAndResolve(tree, tree)` (and none of
// the steps around it in apidef's parse: the `components` it adds, the path
// keys it renames, the headers it drops, its decycle). The results are
// compared as graphs: equal when members, member order, values and which
// objects are shared are all the same. A document that differs is also
// compared as JSON with cycles cut, with and without member order, so that
// a difference in sharing alone, or in order alone, is told from one in
// content (tools/apidef-preset/graph.cjs). Each differing site is given a
// class by its cause (tools/apidef-preset/classify.cjs).
//
// Sets (--sets, default: hand and generated, corpus with --corpus, and
// rows with --rows):
//
//   hand        the edge shapes in tools/apidef-preset/shapes.json
//   generated   documents from a seeded generator (tools/apidef-preset/generate.cjs)
//   corpus      the real descriptions under --corpus, as tools/corpus/sources.cjs
//               lists them, each distinct file once, up to --max-bytes, in
//               --jobs worker processes
//   rows        the rows of each --rows file, a fixture of test/resolve/:
//               a row whose options are `compat: 'apidef'` alone has its
//               input run through apidef's resolver, and the value at its
//               select path held to the row's expected value. The suite
//               holds the preset to those rows; this holds the rows to
//               apidef, so that none pins what apidef does not do.
//
// Options:
//
//   --ref <commit>        load apidef's ts/dist as committed at this commit
//   --sets <a,b,...>      which sets to run
//   --seed <n>            the generator's seed (default 1)
//   --count <n>           how many documents to generate (default 6000)
//   --corpus <dir>        the corpus checkouts (as .corpus/src)
//   --rows <file>...      resolve fixtures to hold to apidef (until the next option)
//   --options <json>      `resolve` options to put beside the preset, to see what
//                         one of its options is there for: every difference
//                         then found is that option's work, named by its class
//   --max-bytes <n>       the largest corpus document to run (default 10000000)
//   --min-bytes <n>       the smallest corpus document to run (default 0), so that
//                         the large ones can be run by themselves, one at a time
//                         with a larger heap
//   --jobs <n>            corpus worker processes (default 3)
//   --heap-mb <n>         each worker's heap limit (default 4096)
//   --timeout <seconds>   the limit for one corpus document (default 300)
//   --minimize-ms <n>     the time to spend shrinking each class's smallest document (default 60000)
//   --no-minimize         do not shrink
//   --report <file>       also write the whole summary as JSON
//
// A document that this package's `parse` refuses reaches neither
// resolver. It is counted apart, as unread, and is neither a difference
// nor a failure: tools/corpus/ is where a refusal is judged.
//
// Exit status: 0 when every document compared is equal and each set
// compared at least one; 1 when a document differs, a resolver threw, a
// row is not what apidef gives, a corpus document ran out of time or
// memory, or a set compared nothing; 2 when the harness could not run. A
// status line is printed at least every 20 seconds while anything runs.

const Fs = require('node:fs')
const Path = require('node:path')
const Child = require('node:child_process')

const ROOT = Path.join(__dirname, '..')
const HELPERS = Path.join(__dirname, 'apidef-preset')
const { loadApidef, LoadError } = require('./apidef-preset/apidef.cjs')
const { compareText } = require('./apidef-preset/compare.cjs')
const { CLASSES, BY_ID } = require('./apidef-preset/classify.cjs')
const { loadShapes } = require('./apidef-preset/shapes.cjs')
const { generate } = require('./apidef-preset/generate.cjs')
const { minimize } = require('./apidef-preset/minimize.cjs')

const DIST = Path.resolve(process.env.OPENAPI_DIST || Path.join(ROOT, 'ts', 'dist', 'openapi.js'))
const STATUS_MS = 15000

// ---- output, with a heartbeat ----

const started = Date.now()
let lastPrint = Date.now()
let status = () => 'starting, percentage unknown'
const secs = (ms) => (ms / 1000).toFixed(1) + 's'
const pct = (n, total) => (0 < total ? Math.floor((100 * n) / total) + '%' : 'percentage unknown')

let sink = (line) => console.log(line)

function log(line = '') {
  sink(line)
  lastPrint = Date.now()
}

// For synchronous loops, which the timer cannot interrupt.
function beat() {
  if (STATUS_MS <= Date.now() - lastPrint) log(`  ... ${status()}, ${secs(Date.now() - started)} in all`)
}

let heartbeat = null

// ---- arguments ----

function usage(msg) {
  if (msg) console.error('apidef-preset: ' + msg)
  console.error('usage: node tools/apidef-preset.cjs <apidef checkout> [--ref <commit>] [--sets hand,generated,corpus]')
  console.error('         [--seed <n>] [--count <n>] [--corpus <dir>] [--max-bytes <n>] [--min-bytes <n>] [--jobs <n>] [--heap-mb <n>]')
  console.error('         [--rows <file>...] [--options <json>] [--timeout <seconds>] [--minimize-ms <n>] [--no-minimize]')
  console.error('         [--report <file>]')
  process.exit(2)
}

function readArgs(argv) {
  const o = {
    apidef: null, ref: null, sets: null, seed: 1, count: 6000, corpus: null, rows: [], maxBytes: 10e6, minBytes: 0,
    jobs: 3, heapMb: 4096, timeout: 300, minimizeMs: 60000, minimize: true, report: null, options: {},
  }
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) usage(`${name} needs a value`)
    return argv[i + 1]
  }
  const num = (text, name) => {
    if (!/^\d+$/.test(text)) usage(`${name} needs a whole number, not ${JSON.stringify(text)}`)
    return Number(text)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if ('--ref' === a) o.ref = value(i++, a)
    else if ('--sets' === a) o.sets = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean)
    else if ('--seed' === a) o.seed = num(value(i++, a), a)
    else if ('--count' === a) o.count = num(value(i++, a), a)
    else if ('--corpus' === a) o.corpus = Path.resolve(value(i++, a))
    else if ('--rows' === a) {
      value(i, a)
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.rows.push(Path.resolve(argv[++i]))
    }
    else if ('--options' === a) {
      const text = value(i++, a)
      try {
        o.options = JSON.parse(text)
      } catch (e) {
        usage(`--options needs JSON: ${e.message}`)
      }
      if (null == o.options || 'object' !== typeof o.options || Array.isArray(o.options)) usage('--options needs a JSON object')
    }
    else if ('--max-bytes' === a) o.maxBytes = num(value(i++, a), a)
    else if ('--min-bytes' === a) o.minBytes = num(value(i++, a), a)
    else if ('--jobs' === a) o.jobs = Math.max(1, num(value(i++, a), a))
    else if ('--heap-mb' === a) o.heapMb = Math.max(256, num(value(i++, a), a))
    else if ('--timeout' === a) o.timeout = Math.max(1, num(value(i++, a), a))
    else if ('--minimize-ms' === a) o.minimizeMs = num(value(i++, a), a)
    else if ('--no-minimize' === a) o.minimize = false
    else if ('--report' === a) o.report = Path.resolve(value(i++, a))
    else if ('--help' === a || '-h' === a) usage()
    else if (a.startsWith('--')) usage(`unknown option ${a}`)
    else if (null == o.apidef) o.apidef = Path.resolve(a)
    else usage(`unexpected argument ${a}`)
  }
  if (null == o.apidef) usage('name the apidef checkout')
  if (null == o.sets) o.sets = ['hand', 'generated', ...(o.corpus ? ['corpus'] : []), ...(0 < o.rows.length ? ['rows'] : [])]
  for (const s of o.sets) if (!['hand', 'generated', 'corpus', 'rows'].includes(s)) usage(`unknown set ${s}`)
  if (o.sets.includes('corpus') && null == o.corpus) usage('the corpus set needs --corpus <dir>')
  if (o.sets.includes('rows') && 0 === o.rows.length) usage('the rows set needs --rows <file>')
  return o
}

// ---- one set's tally ----

function newTally(name) {
  return {
    name, total: 0, equal: 0, verdicts: { content: 0, order: 0, sharing: 0 }, unread: [], failed: [], classes: {},
    // The documents of each class, by name, the first 1000.
    docs: {},
    // The smallest document of each class: { name, bytes, text?, file? }.
    smallest: {},
    left: [],
  }
}

function count(t, item, rec) {
  t.total++
  if (rec.failed) {
    // `parse` refused the text, so neither resolver ran.
    if ('parse' === rec.failed.stage) t.unread.push({ name: item.name, error: rec.failed.error })
    else t.failed.push({ name: item.name, ...rec.failed })
    return
  }
  if ('equal' === rec.verdict) {
    t.equal++
    return
  }
  t.verdicts[rec.verdict] = (t.verdicts[rec.verdict] ?? 0) + 1
  for (const c of rec.classes ?? []) {
    t.classes[c] = (t.classes[c] ?? 0) + 1
    const list = (t.docs[c] ??= [])
    if (list.length < 1000) list.push(item.name)
    const s = t.smallest[c]
    if (null == s || rec.bytes < s.bytes) t.smallest[c] = { name: item.name, bytes: rec.bytes, text: item.text, file: item.file }
  }
}

// The documents of a tally that differ.
const differing = (t) => t.total - t.equal - t.unread.length - t.failed.length

// What a run comes to: the exit status, and why it is not 0.
function verdict(tallies) {
  const why = []
  for (const t of tallies) {
    if (0 < differing(t)) why.push(`${t.name}: ${differing(t)} differ`)
    if (0 < t.failed.length) why.push(`${t.name}: ${t.failed.length} failed`)
    if (0 === t.equal + differing(t)) why.push(`${t.name}: nothing was compared`)
  }
  if (0 === tallies.length) why.push('no set was run')
  return { exit: 0 === why.length ? 0 : 1, why }
}

// ---- the in-process sets ----

function runList(label, items, total, sides) {
  const t = newTally(label)
  const t0 = Date.now()
  status = () => `${label}: ${t.total} of ${total} documents (${pct(t.total, total)})`
  log(`${label}: ${total} documents`)
  for (const item of items) {
    let rec
    try {
      rec = compareText(item.text, sides)
    } catch (e) {
      rec = { failed: { stage: 'harness', error: String(e?.message ?? e).split('\n')[0] } }
    }
    count(t, item, rec)
    beat()
  }
  log(`${label}: ${t.total} documents in ${secs(Date.now() - t0)}`)
  return t
}

// ---- a fixture's rows, held to apidef's resolver ----

// A value as a fixture compares it: after a JSON round trip, without
// member order.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (null != v && 'object' === typeof v) {
    const out = {}
    for (const k of Object.keys(v).sort()) Object.defineProperty(out, k, { value: canonical(v[k]), enumerable: true })
    return out
  }
  return v
}

// The rows of one resolve fixture. The loader is the suite's own, from
// @tabnas/support as ts/ installs it, so a row reads here as it reads
// there.
function runRows(file, sides) {
  const { loadSpec } = require(require.resolve('@tabnas/support', { paths: [Path.join(ROOT, 'ts')] }))
  const label = 'rows ' + Path.relative(ROOT, file)
  const t = newTally(label)
  t.skipped = []
  const spec = loadSpec(file)
  log(`${label}: ${spec.rows.length} rows`)
  for (const row of spec.rows) {
    const name = `${Path.basename(file)}:${row.line}`
    const expected = row.named('expected')
    let opts
    try {
      opts = '' === row.named('opts').trim() ? {} : JSON.parse(row.named('opts'))
    } catch (e) {
      count(t, { name }, { failed: { stage: 'row', error: 'opts is not JSON: ' + e.message } })
      continue
    }
    if ('apidef' !== opts.compat || 1 !== Object.keys(opts).length || expected.startsWith('ERROR')) {
      t.skipped.push(name)
      continue
    }
    let rec
    try {
      const tree = sides.O.parse(row.unescNamed('input'))
      sides.A.addXRefsAndResolve(tree, tree)
      let value = tree
      const select = row.named('select').trim()
      if ('' !== select) for (const seg of JSON.parse(select)) value = value[seg]
      const got = JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))
      const want = JSON.stringify(canonical(JSON.parse(expected)))
      rec = got === want ? { verdict: 'equal' }
        : { failed: { stage: 'row', error: `apidef gives ${got.slice(0, 300)} where the row expects ${want.slice(0, 300)}` } }
    } catch (e) {
      rec = { failed: { stage: 'row', error: String(e?.message ?? e).split('\n')[0] } }
    }
    count(t, { name }, rec)
    beat()
  }
  log(`${label}: ${t.equal} of ${t.total} rows are what apidef's resolver gives; ${t.skipped.length} rows not under the preset alone were left out`)
  return t
}

// ---- the corpus ----

function corpusList(o) {
  const S = require('./corpus/sources.cjs')
  const sources = S.loadSources()
  status = () => 'listing the corpus, percentage unknown'
  let seen = 0
  const all = S.manifest(sources, o.corpus, () => {}, (n) => { seen = n; status = () => `listing the corpus: ${seen} files read, percentage unknown`; beat() })
  const problems = S.countCheck(sources, all)
  const distinct = all.filter((r) => !r.dupOf)
  const run = distinct.filter((r) => o.minBytes <= r.size && r.size <= o.maxBytes)
  const out = distinct.filter((r) => r.size < o.minBytes || r.size > o.maxBytes)
  return { all, distinct, run, out, problems }
}

function runCorpus(o, apidefFile) {
  return new Promise((resolve) => {
    const list = corpusList(o)
    const t = newTally('corpus')
    t.listing = {
      files: list.all.length, distinct: list.distinct.length, run: list.run.length,
      leftOut: list.out.map((r) => ({
        name: r.source + '/' + r.path, bytes: r.size,
        why: r.size > o.maxBytes ? `larger than --max-bytes ${o.maxBytes}` : `smaller than --min-bytes ${o.minBytes}`,
      })),
      problems: list.problems,
    }
    log(`corpus: ${list.all.length} files, ${list.distinct.length} distinct; running the ${list.run.length} of ` +
      `${o.minBytes} to ${o.maxBytes} bytes, leaving out ${list.out.length}; ${o.jobs} workers, ${o.timeout}s each`)
    for (const p of list.problems) log('  note: ' + p)
    // Largest first, so that a slow document does not finish the run alone.
    const queue = list.run.slice().sort((a, b) => b.size - a.size)
      .map((r, i) => ({ id: i, name: r.source + '/' + r.path, file: r.file, size: r.size }))
    const total = queue.length
    const bytesAll = queue.reduce((a, r) => a + r.size, 0)
    let bytesDone = 0
    const t0 = Date.now()
    status = () => `corpus: ${t.total} of ${total} documents (${pct(t.total, total)}), ` +
      `${(bytesDone / 1e6).toFixed(0)} of ${(bytesAll / 1e6).toFixed(0)} MB (${pct(bytesDone, bytesAll)}), ` +
      `${differing(t)} differ, ${t.unread.length} unread, ${t.failed.length} failed`
    const tick = setInterval(() => log('  ' + status() + `, ${secs(Date.now() - t0)}`), 10000)
    let live = 0
    const finish = () => {
      clearInterval(tick)
      log(`corpus: ${t.total} documents in ${secs(Date.now() - t0)}`)
      resolve(t)
    }
    const spawn = () => {
      const child = Child.fork(Path.join(HELPERS, 'worker.cjs'), [apidefFile, DIST, JSON.stringify(o.options)], {
        execArgv: [`--max-old-space-size=${o.heapMb}`, '--stack-size=4000'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      let err = ''
      child.stderr.on('data', (c) => { err = (err + c).slice(-2000) })
      let job = null
      let timer = null
      live++
      const next = () => {
        job = queue.shift()
        if (null == job) {
          child.kill()
          return
        }
        timer = setTimeout(() => {
          const j = job
          job = null
          count(t, j, { failed: { stage: 'timeout', error: `more than ${o.timeout}s` } })
          bytesDone += j.size
          child.kill('SIGKILL')
        }, o.timeout * 1000)
        child.send({ id: job.id, file: job.file })
      }
      child.on('message', (m) => {
        if (m.ready) return next()
        if (null == job || m.id !== job.id) return
        clearTimeout(timer)
        count(t, job, m.rec)
        bytesDone += job.size
        next()
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        live--
        if (null != job) {
          const why = (err.trim().split('\n').pop() ?? '') || `exit ${code ?? signal}`
          count(t, job, { failed: { stage: 'crash', error: why.slice(0, 300) } })
          bytesDone += job.size
          job = null
        }
        if (0 < queue.length) spawn()
        else if (0 === live) finish()
      })
    }
    if (0 === total) return finish()
    for (let i = 0; i < Math.min(o.jobs, total); i++) spawn()
  })
}

// ---- minimal documents ----

// A value as JSON, cycles cut, deep values cut short.
function view(v, depth = 0, path = new Set()) {
  if (null == v || 'object' !== typeof v) return v
  if (path.has(v)) return '<cycle>'
  if (6 < depth) return Array.isArray(v) ? '[...]' : '{...}'
  path.add(v)
  let out
  if (Array.isArray(v)) out = v.map((x) => view(x, depth + 1, path))
  else {
    out = {}
    for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: view(v[k], depth + 1, path), enumerable: true })
  }
  path.delete(v)
  return out
}

function sitesOfClass(text, sides, id) {
  const { A, O } = sides
  const rec = compareText(text, sides)
  const a = O.parse(text)
  A.addXRefsAndResolve(a, a)
  const p = O.resolve(O.parse(text), { compat: 'apidef', ...(sides.options ?? {}) }).tree
  const at = (root, path) => path.reduce((v, k) => (null != v && 'object' === typeof v ? v[k] : undefined), root)
  return (rec.differing ?? []).filter((d) => d.cls === id).map((d) => ({
    at: d.at, ref: d.ref, apidef: d.apidef, preset: d.preset,
    apidefValue: JSON.stringify(view(at(a, d.path))), presetValue: JSON.stringify(view(at(p, d.path))),
  }))
}

function smallestDocs(o, tallies, sides) {
  const ids = [...new Set(tallies.flatMap((t) => Object.keys(t.classes)))]
  const out = {}
  ids.forEach((id, n) => {
    let best = null
    for (const t of tallies) {
      const s = t.smallest[id]
      if (s && (null == best || s.bytes < best.bytes)) best = { ...s, set: t.name }
    }
    const text = best.text ?? Fs.readFileSync(best.file, 'utf8')
    let small = { text: (() => { try { return JSON.stringify(sides.O.parse(text)) } catch { return text } })(), held: null, tries: 0 }
    const holds = (t) => {
      try {
        const r = compareText(t, sides)
        return !r.failed && 'equal' !== r.verdict && r.classes.includes(id)
      } catch {
        return false
      }
    }
    if (o.minimize) {
      const t0 = Date.now()
      status = () => `shrinking class ${n + 1} of ${ids.length} (${id}), percentage unknown`
      small = minimize(small.text, holds, {
        deadline: t0 + o.minimizeMs,
        tick: (i) => {
          status = () => `shrinking class ${n + 1} of ${ids.length} (${id}): ${i.tries} tries, ${i.bytes} bytes, ` +
            `${secs(Date.now() - t0)} of at most ${secs(o.minimizeMs)} (${pct(Date.now() - t0, o.minimizeMs)} of the time allowed)`
          beat()
        },
      })
      if (!small.held) small.text = text
    }
    let sites
    try {
      sites = sitesOfClass(small.text, sides, id)
    } catch (e) {
      sites = [{ error: String(e.message) }]
    }
    out[id] = { from: best.set + ': ' + best.name, bytes: best.bytes, text: small.text, minimized: small.held, sites }
  })
  return out
}

// ---- main ----

async function main() {
  const o = readArgs(process.argv.slice(2))
  heartbeat = setInterval(beat, 2000)
  heartbeat.unref()
  const report = { tool: 'apidef-preset', started: new Date(started).toISOString(), node: process.version, dist: DIST }
  log(`apidef preset against apidef's resolver: apidef at ${o.apidef}${o.ref ? ' (commit ' + o.ref + ')' : ''}, package ${Path.relative(process.cwd(), DIST) || DIST}`)

  let A
  let O
  try {
    A = loadApidef(o.apidef, { ref: o.ref })
    O = require(DIST)
    if ('function' !== typeof O.resolve || 'function' !== typeof O.parse) throw new LoadError(`${DIST} exports no parse and resolve`)
  } catch (e) {
    log('FAIL: ' + e.message)
    return 2
  }
  report.apidef = { checkout: o.apidef, ref: o.ref, commit: A.commit, buildChanged: A.dirty, parseJsSha1: A.sha1 }
  log(`  apidef's resolver: ${A.commit ? A.commit.slice(0, 7) : '(no git)'}${A.dirty ? ', ts/dist/parse.js changed from that commit' : ''}, parse.js sha1 ${A.sha1.slice(0, 12)}`)
  const sides = { A, O, options: o.options }
  if (0 < Object.keys(o.options).length) log(`  beside the preset: ${JSON.stringify(o.options)}`)
  report.options = o.options
  const tallies = []
  try {
    if (o.sets.includes('hand')) {
      const shapes = loadShapes()
      tallies.push(runList('hand', shapes, shapes.length, sides))
    }
    if (o.sets.includes('generated')) {
      tallies.push(runList('generated', generate(o.seed, o.count), o.count, sides))
      tallies[tallies.length - 1].seed = o.seed
    }
    if (o.sets.includes('corpus')) tallies.push(await runCorpus(o, A.file))
    if (o.sets.includes('rows')) for (const file of o.rows) tallies.push(runRows(file, sides))
    const small = smallestDocs(o, tallies, sides)
    report.sets = tallies.map((t) => ({ ...t, smallest: undefined }))
    report.classes = small
    print(o, tallies, small)
  } finally {
    A.cleanup()
  }
  const end = verdict(tallies)
  report.exit = end.exit
  report.why = end.why
  report.ms = Date.now() - started
  if (o.report) {
    Fs.writeFileSync(o.report, JSON.stringify(report, null, 2) + '\n')
    log(`report: ${o.report}`)
  }
  const compared = tallies.reduce((n, t) => n + t.equal + differing(t), 0)
  log(0 === end.exit
    ? `result: no difference in ${compared} compared, exit 0, ${secs(report.ms)}`
    : `result: FAIL (${end.why.join('; ')}), exit 1, ${secs(report.ms)}`)
  clearInterval(heartbeat)
  return report.exit
}

function print(o, tallies, small) {
  log('')
  log('apidef preset summary')
  for (const t of tallies) {
    log(`  ${t.name}${null != t.seed ? ' (seed ' + t.seed + ')' : ''}: ${t.total} documents, ${t.equal} equal, ${differing(t)} differ ` +
      `(content ${t.verdicts.content}, member order only ${t.verdicts.order}, sharing only ${t.verdicts.sharing}), ` +
      `${t.unread.length} unread, ${t.failed.length} failed`)
    if (t.listing) {
      log(`    corpus: ${t.listing.files} files, ${t.listing.distinct} distinct, ${t.listing.run} run, ${t.listing.leftOut.length} left out:`)
      for (const l of t.listing.leftOut.slice(0, 20)) log(`      left out: ${l.name} (${l.bytes} bytes, ${l.why})`)
      if (20 < t.listing.leftOut.length) log(`      and ${t.listing.leftOut.length - 20} more (--report has them all)`)
    }
    if (0 < t.unread.length) {
      // By the code `parse` refused with: the text before the first colon.
      const byCode = {}
      for (const u of t.unread) {
        const code = String(u.error).split(':')[0]
        byCode[code] = (byCode[code] ?? 0) + 1
      }
      log(`    unread, refused by parse and so by neither resolver: ${JSON.stringify(byCode)}`)
      for (const u of t.unread.slice(0, 30)) log(`      unread: ${u.name}: ${u.error}`)
      if (30 < t.unread.length) log(`      and ${t.unread.length - 30} more (--report has them all)`)
    }
    const byStage = {}
    for (const f of t.failed) byStage[f.stage] = (byStage[f.stage] ?? 0) + 1
    if (0 < t.failed.length) log(`    failed by stage: ${JSON.stringify(byStage)}`)
    for (const f of t.failed.slice(0, 30)) log(`      failed: ${f.name}: ${f.stage}: ${f.error}${f.also ? '; ' + f.also : ''}`)
    if (30 < t.failed.length) log(`      and ${t.failed.length - 30} more (--report has them all)`)
  }
  log('')
  log('classes of difference (a document can show several):')
  const ids = Object.keys(small).sort((a, b) => (CLASSES.findIndex((c) => c.id === a) + 1 || 999) - (CLASSES.findIndex((c) => c.id === b) + 1 || 999))
  for (const id of ids) {
    const k = BY_ID.get(id)
    const counts = tallies.map((t) => `${t.name} ${t.classes[id] ?? 0}`).join(', ')
    log('')
    log(`  ${id} [${k ? k.kind : 'unknown'}]: ${k ? k.title : '(no class matched: investigate)'}`)
    log(`    documents: ${counts}`)
    if (k) {
      log(`    apidef: ${k.apidef}`)
      log(`      parse.ts ${k.lines}`)
      log(`    the other reading: ${k.other}`)
      log(`      resolve.ts: ${k.where}`)
    }
    const s = small[id]
    log(`    smallest${s.minimized ? ' (shrunk)' : ''}, from ${s.from}: ${s.text}`)
    for (const site of s.sites.slice(0, 3)) {
      if (site.error) {
        log(`      (could not show the site: ${site.error})`)
        continue
      }
      log(`      at ${site.at || '(root)'} $ref ${JSON.stringify(site.ref)}`)
      log(`        apidef (${site.apidef}): ${site.apidefValue}`)
      log(`        preset (${site.preset}): ${site.presetValue}`)
    }
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    console.error('apidef-preset: ' + (e?.stack ?? e))
    process.exit(2)
  })
}

// For ts/test/apidef-preset.test.ts, which holds the judging to small
// inline documents.
module.exports = {
  readArgs, newTally, count, differing, verdict, canonical, runList, runRows,
  // Where the lines go, in place of the console.
  quiet: (to = () => {}) => { sink = to },
}
