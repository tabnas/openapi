#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/peer-floors.cjs: the floor of each peer range, measured.
//
// The plan's Decision 33 is a standing rule: each `@tabnas` peer of this
// package starts at the first release that has what the package calls,
// and has no ceiling. This tool finds that release by trial. For each
// peer it looks for the oldest published release on which this package's
// own suite passes, with every other peer at its latest, and then runs
// the suite once more with all of them at the floors found.
//
// Run from the repository root, under the Node version `engines` in
// ts/package.json names. It needs the registry, and about ten minutes:
//
//   node tools/peer-floors.cjs            measure, and compare with tools/peer-floors.json
//   node tools/peer-floors.cjs --write    measure, and rewrite tools/peer-floors.json
//   node tools/peer-floors.cjs --only yaml,expr
//
// It never changes this checkout but for `--write`. It works in a
// temporary git worktree of the checkout's tracked state, staged files
// included, with an install of its own there, and removes it at the end
// unless `--keep` is given. Each trial writes exact versions of all the
// peers into that worktree's ts/package.json, installs them afresh,
// checks what was installed, builds and runs the suite, so that no trial
// inherits anything from the one before.
//
// It assumes that once a release passes every later one does, and checks
// the two ends of that: the latest must pass, and the release just under
// the floor must fail. A suite that does not end in 150 seconds has
// failed: an older grammar can leave a hostile input running.
//
// A trial runs every test of the suite but ts/test/peer-floors.test.ts.
// That one holds the manifest and the installed peers to the floors on
// record, so in a trial it would fail every release under the last
// floor measured, whether or not the package works with it, and the
// measurement could only ever agree with itself. For the same reason it
// would fail every trial of a peer that has no record yet.
//
// While an install, a build or a suite runs, a line says so at least
// every 20 seconds, with how far the run is: the trials so far out of
// the most the search can take.
//
// Exit status: 0 when the floors measured are those recorded, or were
// written; 1 when they differ, or the latest of a peer fails, or the
// floors fail together; 2 when it could not run.
//
// What it cannot see: a release between two trials that fails where its
// neighbours pass. A floor says where the suite starts to pass, not that
// every later release was tried.

const { spawn, spawnSync } = require('node:child_process')
const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')

const ROOT = Path.join(__dirname, '..')
const RECORD = Path.join(__dirname, 'peer-floors.json')
const SUITE_LIMIT_MS = 150000
const INSTALL_LIMIT_MS = 600000
const BEAT_MS = 20000

// The test a trial leaves out: the one that holds the peers to the record.
const RECORD_TEST = 'peer-floors.test.js'

// The tests of a trial: every compiled test but that one.
function trialTests(names) {
  return names.filter((name) => name.endsWith('.test.js') && RECORD_TEST !== name).sort()
}

// The most trials a search over releases can take: the latest, the
// first, and a halving of what is between them.
function mostTrials(releases) {
  return releases <= 2 ? releases : 2 + Math.ceil(Math.log2(releases - 1))
}

// The names of the tests a suite's output says failed, the first few and
// each cut short, for the reason a trial gives: a count alone does not
// say whether two trials failed for the same thing.
function failingTests(out, most = 2) {
  const listed = out.split(/^✖ failing tests:$/m)[1] ?? ''
  const names = [...listed.matchAll(/^✖ (.+?) \([0-9.]+ms\)$/gm)].map((m) => m[1])
  const cut = (name) => (60 < name.length ? name.slice(0, 57) + '...' : name)
  return names.slice(0, most).map(cut).join('; ') + (most < names.length ? `; and ${names.length - most} more` : '')
}

// A command run to its end, with a line from `what` every `beatMs` while
// it runs. It gives what spawnSync gives: a status, which is null for a
// command that was stopped at `opts.timeout`, and the two outputs.
function during(what, cmd, args, opts = {}, beatMs = BEAT_MS, say = console.log) {
  return new Promise((done) => {
    const began = Date.now()
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL', ...opts })
    const beat = setInterval(() => say(`   ${what()}, ${Math.round((Date.now() - began) / 1000)}s`), beatMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const end = (status) => {
      clearInterval(beat)
      done({ status, stdout, stderr })
    }
    child.on('error', (err) => ((stderr += String(err)), end(null)))
    child.on('close', (status) => end(status))
  })
}

if (require.main !== module) {
  module.exports = { trialTests, mostTrials, during, failingTests, RECORD_TEST }
  return
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
if (flag('-h') || flag('--help')) {
  console.log('usage: node tools/peer-floors.cjs [--write] [--only <peer>,<peer>] [--keep]')
  process.exit(0)
}

const t0 = Date.now()
const secs = () => Math.round((Date.now() - t0) / 1000) + 's'
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const fail = (msg) => { console.error('peer-floors: ' + msg); process.exit(2) }

function cmp(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

// The peers the manifest names, by their short names.
const manifest = JSON.parse(Fs.readFileSync(Path.join(ROOT, 'ts', 'package.json'), 'utf8'))
const PEERS = Object.keys(manifest.peerDependencies ?? {})
  .filter((n) => n.startsWith('@tabnas/'))
  .map((n) => n.slice('@tabnas/'.length))
  .sort()
if (0 === PEERS.length) fail('ts/package.json names no @tabnas peer')
const only = valueOf('--only')?.split(',')
for (const p of only ?? []) if (!PEERS.includes(p)) fail(`${p} is not a peer of this package`)

// A worktree of the tracked state: the working tree's changes to tracked
// files and anything staged, without touching either.
const stash = run('git', ['stash', 'create'], { cwd: ROOT }).stdout.trim()
const commit = '' === stash ? 'HEAD' : stash
const work = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'peer-floors-'))
const tree = Path.join(work, 'tree')
const added = run('git', ['worktree', 'add', '--detach', tree, commit], { cwd: ROOT })
if (0 !== added.status) fail('could not make a worktree: ' + added.stderr.trim())
const ts = Path.join(tree, 'ts')
const sh = (cmd, args, opts = {}) => run(cmd, args, { cwd: ts, ...opts })
const pkgFile = Path.join(ts, 'package.json')
const original = Fs.readFileSync(pkgFile, 'utf8')

function cleanup() {
  if (flag('--keep')) return console.log('kept: ' + tree)
  run('git', ['worktree', 'remove', '--force', tree], { cwd: ROOT })
  Fs.rmSync(work, { recursive: true, force: true })
}

const versions = (peer) =>
  JSON.parse(sh('npm', ['view', '@tabnas/' + peer, 'versions', '--json']).stdout)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort(cmp)
const installed = (peer) => {
  try {
    return JSON.parse(Fs.readFileSync(Path.join(ts, 'node_modules', '@tabnas', peer, 'package.json'), 'utf8')).version
  } catch {
    return 'absent'
  }
}

let trials = 0
// The most trials this run can take, once the releases are known.
let most = 0
const progress = () => (0 === most ? 'percentage unknown' : `about ${Math.min(99, Math.round((100 * (trials - 1)) / most))}% of the run`)
const step = (label, cmd, args, opts = {}) =>
  during(() => `trial ${trials} of at most ${most}: ${label} (${progress()})`, cmd, args, { cwd: ts, ...opts })

async function trial(combo) {
  trials++
  const pkg = JSON.parse(original)
  for (const p of PEERS) pkg.devDependencies['@tabnas/' + p] = combo[p]
  Fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
  Fs.rmSync(Path.join(ts, 'node_modules', '@tabnas'), { recursive: true, force: true })
  const i = await step('installing', 'npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'], { timeout: INSTALL_LIMIT_MS })
  if (null === i.status) return { ok: false, why: `install: did not end in ${INSTALL_LIMIT_MS / 1000} seconds` }
  if (0 !== i.status) {
    const why = String(i.stderr).split('\n').filter((l) => /ERR!|error/i.test(l)).slice(0, 2).join(' | ')
    return { ok: false, why: 'install: ' + why.replace(/npm error /g, '').slice(0, 160) }
  }
  for (const p of PEERS) if (installed(p) !== combo[p]) return { ok: false, why: `installed ${p} ${installed(p)}, not ${combo[p]}` }
  const b = await step('building', 'npm', ['run', 'build'])
  if (0 !== b.status) {
    const line = (b.stdout + b.stderr).split('\n').find((l) => /error TS/.test(l)) || 'the build failed'
    return { ok: false, why: 'build: ' + line.replace(/^.*?: error /, '').slice(0, 160) }
  }
  const tests = trialTests(Fs.readdirSync(Path.join(ts, 'dist-test'))).map((name) => Path.join('dist-test', name))
  const t = await step(`the suite, ${tests.length} files`, 'node', ['--test', ...tests], { timeout: SUITE_LIMIT_MS })
  // A child of a test can outlive the runner: end what is left of the trial.
  run('pkill', ['-9', '-f', Path.join(ts, 'dist')])
  if (null === t.status) return { ok: false, why: `suite: did not end in ${SUITE_LIMIT_MS / 1000} seconds` }
  const out = t.stdout + t.stderr
  const pass = (/ℹ pass (\d+)/.exec(out) || [])[1]
  const failing = (/ℹ fail (\d+)/.exec(out) || [])[1]
  if (0 !== t.status) {
    const names = failingTests(out)
    return { ok: false, why: `suite: ${failing} of ${Number(pass) + Number(failing)} tests fail` + ('' === names ? '' : ': ' + names) }
  }
  return { ok: true, why: `suite: ${pass} pass` }
}

let exit = 0
const found = {}
;(async () => {
try {
  const first = await during(() => 'installing in the worktree (percentage unknown)', 'npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: ts, timeout: INSTALL_LIMIT_MS })
  if (0 !== first.status) fail('npm install failed in the worktree: ' + String(first.stderr).split('\n')[0])
  const all = {}
  const latest = {}
  for (const p of PEERS) {
    all[p] = versions(p)
    latest[p] = all[p][all[p].length - 1]
  }
  // One more than the searches: the trial of all the floors together.
  most = 1 + PEERS.filter((p) => !only || only.includes(p)).reduce((n, p) => n + mostTrials(all[p].length), 0)
  console.log(`peer-floors: ${PEERS.length} peers, the tracked state at ${commit.slice(0, 7)}; latest: ${PEERS.map((p) => `${p} ${latest[p]}`).join(', ')}; ${most} trials at most`)
  for (const [n, peer] of PEERS.entries()) {
    if (only && !only.includes(peer)) continue
    const list = all[peer]
    console.log(`${n + 1} of ${PEERS.length}: @tabnas/${peer}, ${list.length} releases from ${list[0]} to ${latest[peer]} (${secs()})`)
    const seen = new Map()
    const passes = async (v) => {
      if (!seen.has(v)) {
        const r = await trial({ ...latest, [peer]: v })
        seen.set(v, r)
        console.log(`   trial ${trials} of at most ${most}: ${peer} ${v} ${r.ok ? 'passes' : 'fails'} (${r.why}) (${secs()}, about ${Math.min(99, Math.round((100 * trials) / most))}%)`)
      }
      return seen.get(v).ok
    }
    if (!(await passes(latest[peer]))) {
      console.log(`   the latest release fails, so ${peer} has no floor to find`)
      exit = 1
      continue
    }
    let lo = 0
    let hi = list.length - 1
    if (await passes(list[0])) hi = 0
    else {
      while (1 < hi - lo) {
        const mid = (lo + hi) >> 1
        if (await passes(list[mid])) hi = mid
        else lo = mid
      }
    }
    const under = 0 < hi ? list[hi - 1] : null
    found[peer] = { floor: list[hi], under, fails: under ? seen.get(under).why : null }
    console.log(`   floor: @tabnas/${peer} >=${list[hi]}` + (under ? `; ${under} fails (${seen.get(under).why})` : '; its first release passes'))
  }
  const record = Fs.existsSync(RECORD) ? JSON.parse(Fs.readFileSync(RECORD, 'utf8')) : { floors: {} }
  const floors = { ...Object.fromEntries(PEERS.map((p) => [p, record.floors?.[p]?.floor ?? latest[p]])), ...Object.fromEntries(Object.entries(found).map(([p, f]) => [p, f.floor])) }
  const together = await trial(floors)
  console.log(`all at their floors (${PEERS.map((p) => `${p} ${floors[p]}`).join(', ')}): ${together.ok ? 'passes' : 'fails'} (${together.why}) (${secs()})`)
  if (!together.ok) exit = 1

  if (flag('--write')) {
    if (0 !== exit) console.log('peer-floors: not written, since a trial that must pass failed')
    else {
      const next = {
        note: 'The floor of each @tabnas peer range in ts/package.json, as tools/peer-floors.cjs measured it: the oldest release on which this package\'s suite passes with every other peer at its latest, the release under it, and how that one fails. ts/test/peer-floors.test.ts holds the manifest to this file. The plan\'s Decision 33.',
        measured: new Date().toISOString().slice(0, 10),
        floors: { ...(record.floors ?? {}), ...found },
      }
      Fs.writeFileSync(RECORD, JSON.stringify(next, null, 2) + '\n')
      console.log('peer-floors: wrote ' + Path.relative(ROOT, RECORD))
    }
  } else {
    for (const [p, f] of Object.entries(found)) {
      const was = record.floors?.[p]?.floor
      if (was !== f.floor) {
        console.log(`peer-floors: @tabnas/${p} measures >=${f.floor}, and the record has ${was ?? 'none'}`)
        exit = 1
      }
    }
    if (0 === exit) console.log('peer-floors: the floors measured are the ones recorded')
  }
} finally {
  Fs.writeFileSync(pkgFile, original)
  cleanup()
}
console.log(`peer-floors: ${trials} trials in ${secs()}, exit ${exit}`)
process.exit(exit)
})()
