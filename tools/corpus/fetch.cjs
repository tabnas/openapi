#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/fetch.cjs: fetch the corpus's sources at their pinned commits.
//
// For each source in sources.json, one at a time, it makes a git
// repository in <CORPUS_DIR>/<name> (default .corpus/src in this
// repository), adds the source's repository as `origin`, writes the
// sparse-checkout file where the source has one, fetches exactly the
// pinned commit with `--depth 1` (blobs filtered for a sparse source, so
// only the files checked out are downloaded), and checks out FETCH_HEAD.
// A source already at its pinned commit is skipped. Then it counts each
// source's documents and fails if a count differs from sources.json.
//
// A git transfer can be silent for minutes, so while one runs it prints a
// heartbeat every 15 seconds with the elapsed time and the size on disk.
// On HTTP 429 (the session's git proxy caps concurrent transfers) it
// waits 5 seconds and tries once more. Public repositories are fetched
// anonymously, with GIT_LFS_SKIP_SMUDGE=1.
//
// Run from anywhere; it needs git, the network and about 1.1 GB of disk:
//
//   node tools/corpus/fetch.cjs [--only <source name regex>]

const Fs = require('node:fs')
const Path = require('node:path')
const { spawn } = require('node:child_process')
const S = require('./sources.cjs')

const HEARTBEAT_MS = 15000

function sizeOf(dir) {
  let n = 0
  const st = [dir]
  while (st.length) {
    const d = st.pop()
    let es
    try { es = Fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of es) {
      const p = Path.join(d, e.name)
      if (e.isDirectory()) st.push(p)
      else if (e.isFile()) { try { n += Fs.statSync(p).size } catch {} }
    }
  }
  return n
}
const mb = (n) => (n / 1048576).toFixed(0) + ' MB'
const secs = (ms) => Math.round(ms / 1000) + 's'

// Run git in dir, printing a heartbeat while it runs. Resolves to its stderr tail.
function run(label, dir, args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' }
    const child = spawn('git', args, { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000) })
    const sub = args.find((a, i) => !a.startsWith('-') && '-c' !== args[i - 1])
    const beat = setInterval(() => console.log(`fetch: ${label}: git ${sub} running, ${secs(Date.now() - t0)} elapsed, ${mb(sizeOf(dir))} on disk (percentage unknown)`), HEARTBEAT_MS)
    child.on('error', (e) => { clearInterval(beat); reject(e) })
    child.on('exit', (code, signal) => {
      clearInterval(beat)
      if (0 === code) return resolve(err)
      const e = new Error(`git ${args.join(' ')} failed in ${dir} (${null == code ? signal : 'exit ' + code}): ${err.trim().split('\n').slice(-5).join(' | ')}`)
      e.stderr = err
      reject(e)
    })
  })
}

async function runRetry(label, dir, args) {
  try { return await run(label, dir, args) } catch (e) {
    if (!/\b429\b/.test(String(e.stderr))) throw e
    console.log(`fetch: ${label}: HTTP 429 from the git proxy; waiting 5s and trying once more`)
    await new Promise((ok) => setTimeout(ok, 5000))
    return run(label, dir, args)
  }
}

async function fetchSource(s, dir) {
  const label = s.name
  // An existing folder that is not this source's repository is not ours to replace.
  if (Fs.existsSync(dir) && !Fs.existsSync(Path.join(dir, '.git'))) throw new Error(`${dir} exists and is not a git repository; move it away and run again`)
  Fs.mkdirSync(dir, { recursive: true })
  const url = `https://github.com/${s.repository}`
  if (!Fs.existsSync(Path.join(dir, '.git'))) await run(label, dir, ['init', '-q'])
  try { await run(label, dir, ['remote', 'add', 'origin', url]) } catch { await run(label, dir, ['remote', 'set-url', 'origin', url]) }
  const sparse = S.sparseOf(s)
  if (sparse) {
    await run(label, dir, ['config', 'core.sparseCheckout', 'true'])
    await run(label, dir, ['config', 'core.sparseCheckoutCone', String(sparse.cone)])
    Fs.mkdirSync(Path.join(dir, '.git', 'info'), { recursive: true })
    Fs.writeFileSync(Path.join(dir, '.git', 'info', 'sparse-checkout'), sparse.lines.join('\n') + '\n')
  } else {
    await run(label, dir, ['config', 'core.sparseCheckout', 'false'])
  }
  const fetch = ['fetch', '-q', '--depth', '1', '--no-tags']
  if (sparse) fetch.push('--filter=blob:none')
  fetch.push('origin', s.commit)
  await runRetry(label, dir, fetch)
  // A sparse checkout of a blobless fetch downloads the blobs it needs here.
  await runRetry(label, dir, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', '--detach', 'FETCH_HEAD'])
  if (sparse) await run(label, dir, ['sparse-checkout', 'reapply'])
}

async function main() {
  const args = process.argv.slice(2)
  const i = args.indexOf('--only')
  const only = -1 === i ? null : new RegExp(args[i + 1])
  const sources = S.loadSources()
  const todo = sources.filter((s) => null == only || only.test(s.name))
  const dir = S.corpusDir()
  Fs.mkdirSync(dir, { recursive: true })
  console.log(`fetch: ${todo.length} sources into ${dir}`)
  const t0 = Date.now()
  let n = 0
  for (const s of todo) {
    n++
    const sd = S.sourceDir(s, dir)
    const head = `fetch: ${n} of ${todo.length} sources (${Math.round((100 * (n - 1)) / todo.length)}%): ${s.name}, ${s.repository} at ${s.commit.slice(0, 12)}`
    if (S.isCurrent(s, sd)) { console.log(`${head}: already at its pinned commit, skipped`); continue }
    console.log(`${head}: fetching`)
    const ts = Date.now()
    await fetchSource(s, sd)
    if (!S.isCurrent(s, sd)) throw new Error(`${s.name}: after the fetch, ${sd} is not at ${s.commit}`)
    console.log(`fetch: ${s.name}: done in ${secs(Date.now() - ts)}, ${mb(sizeOf(sd))} on disk`)
  }
  console.log(`fetch: ${todo.length} of ${todo.length} sources (100%), ${secs(Date.now() - t0)} elapsed; counting documents`)
  const recs = S.manifest(todo, dir, (s, k, nf) => console.log(`fetch: counting ${k + 1} of ${todo.length}: ${s.name}, ${nf} files`))
  // Distinct counts depend on the sources before, so check them only on a full fetch.
  const problems = S.countCheck(todo, recs, { distinct: null == only })
  const distinct = recs.filter((r) => !r.dupOf).length
  if (problems.length) {
    for (const p of problems) console.error('fetch: ' + p)
    console.error('fetch: the document counts differ from sources.json, so the corpus is not the pinned one')
    process.exit(1)
  }
  console.log(`fetch: done: ${recs.length} files, ${distinct} distinct documents, every count as sources.json expects`)
}

main().catch((e) => { console.error('fetch: ' + e.message); process.exit(1) })
