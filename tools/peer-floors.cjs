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
// Exit status: 0 when the floors measured are those recorded, or were
// written; 1 when they differ, or the latest of a peer fails, or the
// floors fail together; 2 when it could not run.
//
// What it cannot see: a release between two trials that fails where its
// neighbours pass. A floor says where the suite starts to pass, not that
// every later release was tried.

const { spawnSync } = require('node:child_process')
const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')

const ROOT = Path.join(__dirname, '..')
const RECORD = Path.join(__dirname, 'peer-floors.json')
const SUITE_LIMIT_MS = 150000

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
function trial(combo) {
  trials++
  const pkg = JSON.parse(original)
  for (const p of PEERS) pkg.devDependencies['@tabnas/' + p] = combo[p]
  Fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
  Fs.rmSync(Path.join(ts, 'node_modules', '@tabnas'), { recursive: true, force: true })
  const i = sh('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'])
  if (0 !== i.status) {
    const why = String(i.stderr).split('\n').filter((l) => /ERR!|error/i.test(l)).slice(0, 2).join(' | ')
    return { ok: false, why: 'install: ' + why.replace(/npm error /g, '').slice(0, 160) }
  }
  for (const p of PEERS) if (installed(p) !== combo[p]) return { ok: false, why: `installed ${p} ${installed(p)}, not ${combo[p]}` }
  const b = sh('npm', ['run', 'build'])
  if (0 !== b.status) {
    const line = (b.stdout + b.stderr).split('\n').find((l) => /error TS/.test(l)) || 'the build failed'
    return { ok: false, why: 'build: ' + line.replace(/^.*?: error /, '').slice(0, 160) }
  }
  const t = sh('node', ['--test', 'dist-test/*.test.js'], { timeout: SUITE_LIMIT_MS, killSignal: 'SIGKILL' })
  // A child of a test can outlive the runner: end what is left of the trial.
  run('pkill', ['-9', '-f', Path.join(ts, 'dist')])
  if (null === t.status) return { ok: false, why: `suite: did not end in ${SUITE_LIMIT_MS / 1000} seconds` }
  const out = t.stdout + t.stderr
  const pass = (/ℹ pass (\d+)/.exec(out) || [])[1]
  const failing = (/ℹ fail (\d+)/.exec(out) || [])[1]
  if (0 !== t.status) return { ok: false, why: `suite: ${failing} of ${Number(pass) + Number(failing)} tests fail` }
  return { ok: true, why: `suite: ${pass} pass` }
}

let exit = 0
const found = {}
try {
  const first = sh('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'])
  if (0 !== first.status) fail('npm install failed in the worktree: ' + String(first.stderr).split('\n')[0])
  const all = {}
  const latest = {}
  for (const p of PEERS) {
    all[p] = versions(p)
    latest[p] = all[p][all[p].length - 1]
  }
  console.log(`peer-floors: ${PEERS.length} peers, the tracked state at ${commit.slice(0, 7)}; latest: ${PEERS.map((p) => `${p} ${latest[p]}`).join(', ')}`)
  for (const [n, peer] of PEERS.entries()) {
    if (only && !only.includes(peer)) continue
    const list = all[peer]
    console.log(`${n + 1} of ${PEERS.length}: @tabnas/${peer}, ${list.length} releases from ${list[0]} to ${latest[peer]} (${secs()})`)
    const seen = new Map()
    const passes = (v) => {
      if (!seen.has(v)) {
        const r = trial({ ...latest, [peer]: v })
        seen.set(v, r)
        console.log(`   trial ${trials}: ${peer} ${v} ${r.ok ? 'passes' : 'fails'} (${r.why}) (${secs()}, percentage unknown)`)
      }
      return seen.get(v).ok
    }
    if (!passes(latest[peer])) {
      console.log(`   the latest release fails, so ${peer} has no floor to find`)
      exit = 1
      continue
    }
    let lo = 0
    let hi = list.length - 1
    if (passes(list[0])) hi = 0
    else {
      while (1 < hi - lo) {
        const mid = (lo + hi) >> 1
        if (passes(list[mid])) hi = mid
        else lo = mid
      }
    }
    const under = 0 < hi ? list[hi - 1] : null
    found[peer] = { floor: list[hi], under, fails: under ? seen.get(under).why : null }
    console.log(`   floor: @tabnas/${peer} >=${list[hi]}` + (under ? `; ${under} fails (${seen.get(under).why})` : '; its first release passes'))
  }
  const record = Fs.existsSync(RECORD) ? JSON.parse(Fs.readFileSync(RECORD, 'utf8')) : { floors: {} }
  const floors = { ...Object.fromEntries(PEERS.map((p) => [p, record.floors?.[p]?.floor ?? latest[p]])), ...Object.fromEntries(Object.entries(found).map(([p, f]) => [p, f.floor])) }
  const together = trial(floors)
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
