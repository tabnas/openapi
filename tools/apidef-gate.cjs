#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-gate.cjs: the apidef gate. It proves, from this checkout,
// that apidef still behaves with this package in place of its own
// resolver: it runs apidef's TypeScript test suite against this checkout's
// build, and compares apidef's guide and model on a set of definitions
// with those of apidef as it was before.
//
// Run from the repository root, under the Node version `engines` in
// ts/package.json names:
//
//   node tools/apidef-gate.cjs ../apidef
//   node tools/apidef-gate.cjs ../apidef --patch docs/design/prototype/e9-apidef-swap/variant1.diff
//
// The apidef checkout must have its dependencies installed (`npm ci` in
// its ts/). The gate never changes that checkout's tracked files. It
// works in temporary git worktrees of it, each with a `ts/node_modules`
// that is a link to the checkout's own, and removes them at the end. In
// that `node_modules`, `@tabnas/openapi` must be a link to this
// checkout's ts/; the gate makes the link if it is missing, says so, and
// leaves it in place, and adds nothing else there.
//
// Steps:
//
// 1. Its ground: the Node version, the apidef checkout, its commit,
//    branch and tree, its dependencies, and the link.
// 2. `npm run build` in this checkout's ts/, unless --no-build.
// 3. The candidate: a worktree of apidef at its current commit (or
//    --ref), with --patch applied if given. The base: a second worktree,
//    at the same commit unpatched when --patch is given, and otherwise at
//    apidef's `main` (or --base). Each is built with apidef's own
//    TypeScript.
// 4. Which copies are tested: the real path apidef resolves
//    `@tabnas/openapi` to, which must be this checkout's ts/, and every
//    `@tabnas` package each side loads, with its version.
// 5. apidef's suite in the candidate: the `node --test` run its
//    `npm test` ends with. The comment gate, the dependency gate and the
//    dependency gate's own suite, which its `npm test` runs first, are
//    left out: they judge apidef's source and committed manifests, not
//    what apidef does with this package, and the swap's patch is not
//    committed, so the dependency gate could not see it anyway.
// 6. apidef's guide and model, candidate against base, for every OpenAPI
//    description in apidef's ts/test/def/, this repository's
//    test/petstore/ pair and each --extra file: byte for byte, and again
//    with the guide's `$`-suffixed copies of the input left out.
//
// Options:
//
//   --patch <diff>        apply this diff to the candidate
//   --ref <commit>        the candidate's commit (default: the checkout's HEAD)
//   --base <commit>       the base's commit, without --patch (default: main)
//   --extra <file>...     further descriptions to compare (until the next option)
//   --allow-failures <n>  the number of failing tests accepted (default 0)
//   --jobs <n>            definitions run at a time (default: CPUs less one, at most 4)
//   --timeout <seconds>   the limit for one definition on one side (default 300)
//   --no-build            do not build this checkout first
//   --work <dir>          where the worktrees go (default: a new temporary folder)
//   --keep                keep the worktrees and outputs
//   --report <file>       also write the summary as one JSON object
//
// Exit status: 0 when no test fails beyond --allow-failures, every
// definition compared is byte-identical in apidef's output, and apidef
// loads this checkout's package; 1 when any of those fails; 2 when the
// gate cannot run (a usage error, or ground it does not stand on); 3 when
// everything else holds but apidef at that commit does not import
// `@tabnas/openapi` at all, so the run proves nothing about this package.
//
// What it cannot see: it tests apidef's TypeScript suite and output, and
// nothing else apidef has. It tests whatever this checkout's ts/dist holds
// when it runs, reached through a link, not the package as it would be
// installed from the registry, and its dependencies as this checkout
// installed them. The comparison covers the definitions it is given, and
// two runs that fail in the same way compare as identical.

const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')
const Child = require('node:child_process')

const ROOT = Path.join(__dirname, '..')
const TS = Path.join(ROOT, 'ts')
const HELPERS = Path.join(__dirname, 'apidef-gate')
const SUITE_GLOB = 'dist-test/**/*.test.js'
const SUITE_SCRIPT = 'node --enable-source-maps --test "dist-test/**/*.test.js"'
const HEARTBEAT_MS = 20000

// ---- output, with a heartbeat ----

const started = Date.now()
let lastPrint = Date.now()
let status = () => 'starting'

const shown = (p) => (p.startsWith(ROOT + Path.sep) ? Path.relative(ROOT, p) : p)
const secs = (ms) => (ms / 1000).toFixed(1) + 's'
const pct = (n, total) => (0 < total ? Math.floor((100 * n) / total) + '%' : 'percentage unknown')

function log(line = '') {
  console.log(line)
  lastPrint = Date.now()
}

const heartbeat = setInterval(() => {
  if (HEARTBEAT_MS <= Date.now() - lastPrint) {
    log(`  ... ${status()}, ${secs(Date.now() - started)} in all`)
  }
}, 2000)
heartbeat.unref()

// ---- arguments ----

function usage(msg) {
  if (msg) console.error('apidef-gate: ' + msg)
  console.error('usage: node tools/apidef-gate.cjs <apidef checkout> [--patch <diff>] [--ref <commit>]')
  console.error('         [--base <commit>] [--extra <file>...] [--allow-failures <n>] [--jobs <n>]')
  console.error('         [--timeout <seconds>] [--no-build] [--work <dir>] [--keep] [--report <file>]')
  process.exit(2)
}

function readArgs(argv) {
  const opts = {
    apidef: null, patch: null, ref: null, base: null, extra: [], allowFailures: 0,
    jobs: Math.max(1, Math.min(4, (Os.availableParallelism?.() ?? Os.cpus().length) - 1)),
    timeout: 300, build: true, work: null, keep: false, report: null,
  }
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) usage(`${name} needs a value`)
    return argv[i + 1]
  }
  const count = (text, name) => {
    if (!/^\d+$/.test(text)) usage(`${name} needs a whole number, not ${JSON.stringify(text)}`)
    return Number(text)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if ('--patch' === a) opts.patch = Path.resolve(value(i++, a))
    else if ('--ref' === a) opts.ref = value(i++, a)
    else if ('--base' === a) opts.base = value(i++, a)
    else if ('--allow-failures' === a) opts.allowFailures = count(value(i++, a), a)
    else if ('--jobs' === a) opts.jobs = Math.max(1, count(value(i++, a), a))
    else if ('--timeout' === a) opts.timeout = Math.max(1, count(value(i++, a), a))
    else if ('--work' === a) opts.work = Path.resolve(value(i++, a))
    else if ('--report' === a) opts.report = Path.resolve(value(i++, a))
    else if ('--no-build' === a) opts.build = false
    else if ('--keep' === a) opts.keep = true
    else if ('--extra' === a) {
      value(i, a)
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.extra.push(Path.resolve(argv[++i]))
    } else if ('--help' === a || '-h' === a) usage()
    else if (a.startsWith('--')) usage(`unknown option ${a}`)
    else if (null == opts.apidef) opts.apidef = Path.resolve(a)
    else usage(`unexpected argument ${a}`)
  }
  if (null == opts.apidef) usage('name the apidef checkout')
  if (opts.patch && opts.base) usage('--base is for runs without --patch; with --patch the base is the patched commit')
  return opts
}

// ---- processes ----

const children = new Set()

function gitSync(dir, ...args) {
  return Child.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryGit(dir, ...args) {
  try {
    return gitSync(dir, ...args)
  } catch {
    return null
  }
}

// A child process, its output read line by line. `onLine` sees each line
// of stdout; stderr is kept. Resolves with the exit code or signal.
function run(cmd, args, { cwd, env, onLine, timeoutMs, echo } = {}) {
  return new Promise((resolve) => {
    const child = Child.spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let out = ''
    let err = ''
    let timedOut = false
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs) : null
    const lines = (chunk, sink) => {
      sink.buf += chunk
      let nl
      while (-1 !== (nl = sink.buf.indexOf('\n'))) {
        const line = sink.buf.slice(0, nl)
        sink.buf = sink.buf.slice(nl + 1)
        sink.each(line)
      }
    }
    const stdout = { buf: '', each: (line) => { if (onLine) onLine(line); else { out += line + '\n'; if (echo) log('    ' + line) } } }
    const stderr = { buf: '', each: (line) => { err += line + '\n'; if (echo) log('    ' + line) } }
    child.stdout.setEncoding('utf8').on('data', (c) => lines(c, stdout))
    child.stderr.setEncoding('utf8').on('data', (c) => lines(c, stderr))
    child.on('error', (e) => { err += String(e.message) + '\n' })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      children.delete(child)
      if (stdout.buf) stdout.each(stdout.buf)
      if (stderr.buf) stderr.each(stderr.buf)
      resolve({ code, signal, out, err, timedOut })
    })
  })
}

// Child processes run this Node first on PATH, so that a script's `node`
// is the one the gate was started with.
const childEnv = () => ({ ...process.env, PATH: Path.dirname(process.execPath) + Path.delimiter + process.env.PATH })

// ---- step 1: ground ----

// A Node version against an `engines` range of comparators (>=, >, <=, <, =).
function satisfies(version, range) {
  const num = (v) => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0)
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
    return 0
  }
  const have = num(version)
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/.exec(part)
    if (!m) return null
    const c = cmp(have, num(m[2]))
    const op = m[1] ?? '='
    const ok = { '>=': 0 <= c, '<=': 0 >= c, '>': 0 < c, '<': 0 > c, '=': 0 === c }[op]
    if (!ok) return false
  }
  return true
}

function ground(opts, report) {
  log('1. ground')
  const fail = (msg) => {
    log('   FAIL: ' + msg)
    report.reasons.push(msg)
    return false
  }

  const engines = JSON.parse(Fs.readFileSync(Path.join(TS, 'package.json'), 'utf8')).engines?.node
  const ok = engines ? satisfies(process.version, engines) : true
  report.node = { version: process.version, engines: engines ?? null }
  if (null === ok) return fail(`ts/package.json names engines.node ${JSON.stringify(engines)}, which this gate cannot read`)
  if (!ok) return fail(`Node ${process.version} does not satisfy engines.node ${engines} in ts/package.json; put that Node first on PATH`)
  log(`   node ${process.version}, engines.node ${engines ?? '(none)'}: ok`)

  const own = {
    commit: tryGit(ROOT, 'rev-parse', 'HEAD'),
    branch: tryGit(ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'),
    changed: (tryGit(ROOT, 'status', '--short') ?? '').split('\n').filter(Boolean).length,
  }
  report.openapi = { dir: ROOT, ...own }
  log(`   this checkout: ${ROOT}, ${own.branch} at ${own.commit?.slice(0, 7)}, ` +
    (0 === own.changed ? 'tree clean' : `${own.changed} paths changed or untracked`))

  const dir = opts.apidef
  if (!Fs.existsSync(dir)) return fail(`no apidef checkout at ${dir}`)
  const top = tryGit(dir, 'rev-parse', '--show-toplevel')
  if (null == top || Fs.realpathSync(top) !== Fs.realpathSync(dir)) return fail(`${dir} is not the top of a git checkout`)
  const tsdir = Path.join(dir, 'ts')
  let pkg
  try {
    pkg = JSON.parse(Fs.readFileSync(Path.join(tsdir, 'package.json'), 'utf8'))
  } catch {
    return fail(`${dir} has no ts/package.json; is it apidef?`)
  }
  if ('@voxgig/apidef' !== pkg.name) return fail(`${dir}/ts/package.json names ${pkg.name}, not @voxgig/apidef`)

  const apidef = {
    dir,
    commit: gitSync(dir, 'rev-parse', 'HEAD'),
    branch: gitSync(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    changed: gitSync(dir, 'status', '--short').split('\n').filter(Boolean).length,
    version: pkg.version,
  }
  report.apidef = apidef
  log(`   apidef: ${dir}, ${pkg.name} ${pkg.version}, ${apidef.branch} at ${apidef.commit.slice(0, 7)}, ` +
    (0 === apidef.changed
      ? 'tree clean'
      : `${apidef.changed} paths changed or untracked (not tested: the gate works from commits)`))

  // Dependencies: every package apidef's manifest names, bar optional peers.
  const modules = Path.join(tsdir, 'node_modules')
  const optional = new Set(Object.keys(pkg.peerDependenciesMeta ?? {}).filter((n) => pkg.peerDependenciesMeta[n]?.optional))
  const wanted = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}).filter((n) => !optional.has(n)),
  ]
  const missing = [...new Set(wanted)].filter((n) => !Fs.existsSync(Path.join(modules, n, 'package.json')))
  if (0 < missing.length) {
    return fail(`apidef's dependencies are not installed (missing ${missing.join(', ')}); ` +
      `run: (cd ${tsdir} && npm ci)`)
  }
  log(`   apidef's dependencies: ${new Set(wanted).size} of ${new Set(wanted).size} installed in ts/node_modules`)

  // The link, which is the one thing the gate may add to node_modules.
  const link = Path.join(modules, '@tabnas', 'openapi')
  let st = null
  try {
    st = Fs.lstatSync(link)
  } catch {
    // Absent: made below.
  }
  report.link = { path: link, made: false }
  if (null == st) {
    Fs.mkdirSync(Path.dirname(link), { recursive: true })
    Fs.symlinkSync(TS, link, 'dir')
    report.link.made = true
    log(`   made the link ${link} -> ${TS}; it is in apidef's ignored node_modules and is left there`)
  } else if (!st.isSymbolicLink()) {
    return fail(`${link} is an installed copy, not a link to ${TS}; the gate will not replace it`)
  } else {
    const target = Fs.readlinkSync(link)
    let real = null
    try {
      real = Fs.realpathSync(link)
    } catch {
      // A dangling link.
    }
    if (real !== Fs.realpathSync(TS)) {
      return fail(`${link} links to ${target}` + (null == real ? ', which does not exist' : '') +
        `, not to this checkout's ${TS}; the gate will not change it`)
    }
    log(`   link: ${link} -> ${target}`)
  }
  report.link.target = Fs.readlinkSync(link)
  return true
}

// ---- step 2: build this checkout ----

function newest(dir) {
  let t = 0
  if (!Fs.existsSync(dir)) return t
  for (const e of Fs.readdirSync(dir, { withFileTypes: true })) {
    const p = Path.join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newest(p) : Fs.statSync(p).mtimeMs)
  }
  return t
}

async function buildOwn(opts, report) {
  log('2. this checkout\'s build')
  if (opts.build) {
    log(`   npm run build in ${TS}`)
    const t0 = Date.now()
    status = () => `building this checkout, ${secs(Date.now() - t0)}, percentage unknown`
    const r = await run('npm', ['run', 'build'], { cwd: TS, env: childEnv(), echo: true })
    report.build = { ran: true, ok: 0 === r.code, ms: Date.now() - t0 }
    if (0 !== r.code) {
      report.reasons.push(`npm run build in ${TS} failed`)
      log(`   FAIL: npm run build failed (exit ${r.code ?? r.signal})`)
      return false
    }
    log(`   built in ${secs(Date.now() - t0)}`)
  } else {
    report.build = { ran: false }
    log('   --no-build: testing ts/dist as it stands')
  }
  if (!Fs.existsSync(Path.join(TS, 'dist', 'openapi.js'))) {
    report.reasons.push('ts/dist/openapi.js is missing; build this checkout')
    log('   FAIL: ts/dist/openapi.js is missing; build this checkout (npm run build in ts/)')
    return false
  }
  const src = newest(Path.join(TS, 'src'))
  const dist = newest(Path.join(TS, 'dist'))
  if (src > dist) {
    report.build.stale = true
    log('   note: a file in ts/src is newer than everything in ts/dist; the gate tests ts/dist, not ts/src')
  }
  return true
}

// ---- step 3: worktrees ----

const worktrees = []
let workDir = null
let workMade = false

function resolveCommit(dir, ref) {
  return tryGit(dir, 'rev-parse', '--verify', '--quiet', ref + '^{commit}')
}

async function addWorktree(opts, name, commit) {
  const dir = Path.join(workDir, name)
  const t0 = Date.now()
  status = () => `adding the ${name} worktree, ${secs(Date.now() - t0)}, percentage unknown`
  const r = await run('git', ['-C', opts.apidef, 'worktree', 'add', '--detach', dir, commit])
  if (0 !== r.code) throw new Error(`git worktree add for the ${name} failed: ${r.err.trim()}`)
  worktrees.push(dir)
  Fs.symlinkSync(Path.join(opts.apidef, 'ts', 'node_modules'), Path.join(dir, 'ts', 'node_modules'), 'dir')
  return dir
}

// apidef's own TypeScript, run as its `npm run build` does.
async function buildApidef(name, dir) {
  const t0 = Date.now()
  const r = await run('npm', ['run', 'build'], { cwd: Path.join(dir, 'ts'), env: childEnv() })
  const ok = 0 === r.code
  log(`   ${name}: apidef's build ${ok ? 'done' : 'FAILED'} in ${secs(Date.now() - t0)}`)
  if (!ok) for (const line of (r.out + r.err).trim().split('\n').slice(-20)) log('     ' + line)
  return ok
}

async function prepare(opts, report) {
  log('3. worktrees')
  const candidate = resolveCommit(opts.apidef, opts.ref ?? 'HEAD')
  if (null == candidate) throw new GroundError(`apidef has no commit ${opts.ref}`)
  let baseRef
  let base
  if (opts.patch) {
    if (!Fs.existsSync(opts.patch)) throw new GroundError(`no patch at ${opts.patch}`)
    baseRef = '(the candidate\'s commit)'
    base = candidate
  } else {
    baseRef = opts.base ?? 'main'
    base = resolveCommit(opts.apidef, baseRef)
    if (null == base && null == opts.base) base = resolveCommit(opts.apidef, baseRef = 'origin/main')
    if (null == base) throw new GroundError(`apidef has no commit ${baseRef}`)
  }
  report.mode = {
    patch: opts.patch ? shown(opts.patch) : null,
    candidate: { ref: opts.ref ?? 'HEAD', commit: candidate },
    base: { ref: baseRef, commit: base },
  }

  if (opts.work) {
    if (Fs.existsSync(opts.work) && 0 < Fs.readdirSync(opts.work).length) {
      throw new GroundError(`--work ${opts.work} is not empty`)
    }
    workMade = !Fs.existsSync(opts.work)
    Fs.mkdirSync(opts.work, { recursive: true })
    workDir = Fs.realpathSync(opts.work)
  } else {
    workDir = Fs.mkdtempSync(Path.join(Fs.realpathSync(Os.tmpdir()), 'apidef-gate-'))
    workMade = true
  }
  log(`   work folder: ${workDir}`)

  const cand = await addWorktree(opts, 'candidate', candidate)
  log(`   candidate: ${cand}, apidef at ${candidate.slice(0, 7)}`)
  if (opts.patch) {
    const check = await run('git', ['-C', cand, 'apply', '--check', opts.patch])
    if (0 !== check.code) throw new GroundError(`the patch does not apply at ${candidate.slice(0, 7)}: ${check.err.trim()}`)
    const applied = await run('git', ['-C', cand, 'apply', opts.patch])
    if (0 !== applied.code) throw new GroundError(`git apply failed: ${applied.err.trim()}`)
    const files = gitSync(cand, 'diff', '--stat').split('\n')
    log(`   patched with ${shown(opts.patch)}: ${files[files.length - 1].trim()}`)
  }
  const baseDir = await addWorktree(opts, 'base', base)
  log(`   base: ${baseDir}, apidef at ${base.slice(0, 7)} ${baseRef}, unpatched`)
  if (base === candidate && !opts.patch) {
    log('   note: the base is the candidate\'s own commit, so the comparison shows only that apidef\'s output is repeatable')
  }

  const t0 = Date.now()
  status = () => `building apidef in the two worktrees, ${secs(Date.now() - t0)}, percentage unknown`
  const built = await Promise.all([buildApidef('candidate', cand), buildApidef('base', baseDir)])
  if (!built[0]) report.reasons.push('apidef\'s build failed in the candidate')
  if (!built[1]) report.reasons.push('apidef\'s build failed in the base')
  return built[0] && built[1] ? { cand, base: baseDir } : null
}

class GroundError extends Error {}

// ---- step 4: which copies ----

async function probe(dir, def) {
  const r = await run(process.execPath, [Path.join(HELPERS, 'probe.cjs'), Path.join(dir, 'ts'), TS, def],
    { cwd: Path.join(dir, 'ts'), env: childEnv(), timeoutMs: 120000 })
  try {
    return JSON.parse(r.out.trim().split('\n').pop())
  } catch {
    return { probeError: (r.err.trim().split('\n').pop() ?? '') || `exit ${r.code ?? r.signal}` }
  }
}

async function copies(opts, wt, report) {
  log('4. which copies are tested')
  const def = Path.join(ROOT, 'test', 'petstore', 'petstore.json')
  status = () => 'probing which copies apidef loads, percentage unknown'
  const [cand, base] = await Promise.all([probe(wt.cand, def), probe(wt.base, def)])
  report.copies = { candidate: cand, base }
  if (cand.probeError) {
    report.reasons.push('the probe of the candidate failed: ' + cand.probeError)
    log('   FAIL: the probe of the candidate failed: ' + cand.probeError)
    return false
  }
  const own = Fs.realpathSync(TS)
  const realModules = Fs.realpathSync(Path.join(opts.apidef, 'ts', 'node_modules'))
  const where = (d) =>
    d === own ? 'this checkout'
      : d.startsWith(own + Path.sep) ? 'this checkout: ' + Path.relative(own, d)
        : d.startsWith(realModules + Path.sep) ? 'apidef: ' + Path.relative(Path.dirname(realModules), d)
          : d
  log(`   @tabnas/openapi resolves from the candidate to ${cand.resolved ?? '(nothing: ' + cand.resolveError + ')'}`)
  let ok = true
  if (cand.resolved !== own) {
    ok = false
    const msg = `apidef resolves @tabnas/openapi to ${cand.resolved ?? 'nothing'}, not to this checkout's ${own}`
    report.reasons.push(msg)
    log('   FAIL: ' + msg)
  }
  log(`   apidef's parse of test/petstore/petstore.json: ` +
    (cand.parseError ? 'threw ' + cand.parseError : `${cand.parsed.paths} paths`))
  log('   @tabnas packages the candidate loaded:')
  for (const p of cand.loaded) log(`     ${p.name} ${p.version}  (${where(p.dir)})`)
  if (!cand.importsOpenapi) {
    log('   NOTE: apidef at this commit does not import @tabnas/openapi: no file of this checkout was loaded.')
    log('         The suite and the comparison below prove nothing about this package.')
  } else {
    log('   apidef imports @tabnas/openapi from this checkout')
  }
  if (!base.probeError) {
    log(`   the base ${base.importsOpenapi ? 'also imports' : 'does not import'} @tabnas/openapi`)
  }
  return ok
}

// ---- step 5: apidef's suite ----

function countFiles(dir) {
  let n = 0
  if (!Fs.existsSync(dir)) return n
  for (const e of Fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(Path.join(dir, e.name))
    else if (e.name.endsWith('.test.js')) n++
  }
  return n
}

async function suite(opts, wt, report) {
  log('5. apidef\'s suite, in the candidate')
  const tsdir = Path.join(wt.cand, 'ts')
  const script = JSON.parse(Fs.readFileSync(Path.join(tsdir, 'package.json'), 'utf8')).scripts?.test ?? ''
  const parts = script.split('&&').map((s) => s.trim()).filter(Boolean)
  const others = parts.filter((p) => p !== SUITE_SCRIPT)
  if (!parts.includes(SUITE_SCRIPT)) {
    log(`   note: apidef's npm test no longer reads ${SUITE_SCRIPT}; running that all the same`)
  }
  if (0 < others.length) log(`   left out of apidef's npm test, as housekeeping: ${others.join('; ')}`)
  report.suite = { leftOut: others }

  const files = countFiles(Path.join(tsdir, 'dist-test'))
  const seen = new Set()
  const stack = new Map()
  const failures = []
  let done = 0
  let summary = null
  const t0 = Date.now()
  status = () => `suite: ${done} tests finished, ${seen.size} of ${files} files started (${pct(seen.size, files)})`
  const tick = setInterval(() => log('   ' + status() + `, ${secs(Date.now() - t0)}`), 10000)
  const r = await run(process.execPath, [
    '--enable-source-maps', '--test',
    '--test-reporter=' + Path.join(HELPERS, 'reporter.cjs'), '--test-reporter-destination=stdout',
    SUITE_GLOB,
  ], {
    cwd: tsdir,
    env: childEnv(),
    timeoutMs: 30 * 60 * 1000,
    onLine: (line) => {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      if (e.file) seen.add(e.file)
      const key = e.file ?? ''
      if ('start' === e.event) {
        const names = (stack.get(key) ?? []).slice(0, e.nesting)
        names[e.nesting] = e.name
        stack.set(key, names)
      } else if ('pass' === e.event || 'fail' === e.event) {
        if ('suite' !== e.type) done++
        if ('fail' === e.event && 'suite' !== e.type) {
          const path = [...(stack.get(key) ?? []).slice(0, e.nesting), e.name].join(' > ')
          const at = e.file ? `${Path.relative(tsdir, e.file)}:${e.line}` : '(no file)'
          failures.push({ name: path, at, error: e.error })
          log(`   failed: ${path}  (${at})`)
        }
      } else if ('summary' === e.event) {
        summary = e.counts
      }
    },
  })
  clearInterval(tick)
  if (null == summary) {
    const msg = `apidef's suite gave no summary (exit ${r.code ?? r.signal}${r.timedOut ? ', timed out' : ''})`
    report.reasons.push(msg)
    log('   FAIL: ' + msg)
    for (const line of r.err.trim().split('\n').slice(-20)) log('     ' + line)
    report.suite.ran = false
    return false
  }
  const s = {
    ran: true,
    tests: summary.tests,
    suites: summary.suites,
    passed: summary.passed,
    failed: summary.failed,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    todo: summary.todo,
    ms: Date.now() - t0,
    failures,
  }
  Object.assign(report.suite, s)
  log(`   ${s.tests} tests in ${s.suites} suites: ${s.passed} pass, ${s.failed} fail, ` +
    `${s.cancelled} cancelled, ${s.skipped} skipped, ${s.todo} todo, in ${secs(s.ms)}`)
  for (const f of failures) {
    log(`   failing: ${f.name}`)
    log(`     at ${f.at}`)
    for (const line of String(f.error ?? '').split('\n')) log('     ' + line)
  }
  const bad = s.failed + s.cancelled
  if (bad > opts.allowFailures) {
    const msg = `${bad} ${1 === bad ? 'test' : 'tests'} failed or cancelled in apidef's suite, past --allow-failures ${opts.allowFailures}`
    report.reasons.push(msg)
    log('   FAIL: ' + msg)
    return false
  }
  if (bad < opts.allowFailures) {
    log(`   note: ${bad} failed where ${opts.allowFailures} are allowed; lower --allow-failures`)
  }
  return true
}

// ---- step 6: apidef's output, candidate against base ----

// An OpenAPI or Swagger description, by its root's version member, read
// without this package so that the choice does not depend on what is tested.
function isDescription(file) {
  const text = Fs.readFileSync(file, 'utf8')
  if (/\.json$/i.test(file)) {
    try {
      const root = JSON.parse(text)
      return null != root && 'object' === typeof root && ('openapi' in root || 'swagger' in root)
    } catch {
      return false
    }
  }
  if (/\.ya?ml$/i.test(file)) return /^["']?(openapi|swagger)["']?\s*:/m.test(text)
  return false
}

function definitions(opts, wt) {
  const defDir = Path.join(wt.cand, 'ts', 'test', 'def')
  const list = []
  for (const name of Fs.readdirSync(defDir).sort()) {
    const file = Path.join(defDir, name)
    if (name.endsWith('.full.json') || !Fs.statSync(file).isFile()) continue
    if (isDescription(file)) list.push({ label: 'apidef ts/test/def/' + name, file })
  }
  for (const name of ['petstore.json', 'petstore.yaml']) {
    list.push({ label: 'test/petstore/' + name, file: Path.join(ROOT, 'test', 'petstore', name) })
  }
  for (const file of opts.extra) {
    if (!Fs.existsSync(file)) throw new GroundError(`no --extra file at ${file}`)
    list.push({ label: 'extra ' + file, file })
  }
  return list
}

// The guide carries copies of the definition under keys ending in `$`.
// They are apidef's input, not its output.
const core = (v) => Array.isArray(v) ? v.map(core)
  : null != v && 'object' === typeof v
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.endsWith('$')).map(([k, x]) => [k, core(x)]))
    : v

const pointer = (path) => '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')

// Where two parsed outputs first part, as a JSON pointer, in key order.
function firstDifference(a, b, path = []) {
  if (a === b) return null
  if (null == a || null == b || 'object' !== typeof a || 'object' !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    const show = (v) => (undefined === v ? '(absent)' : String(JSON.stringify(v)).slice(0, 100))
    return { at: pointer(path), candidate: show(a), base: show(b) }
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  for (const k of new Set([...ka, ...kb])) {
    const d = firstDifference(a[k], b[k], [...path, k])
    if (d) return d
  }
  if (ka.join('\0') !== kb.join('\0')) {
    return { at: pointer(path), candidate: 'keys ' + ka.join(','), base: 'keys ' + kb.join(',') }
  }
  return null
}

function compareOne(item, candText, baseText) {
  const res = {
    label: item.label,
    bytes: { candidate: Buffer.byteLength(candText), base: Buffer.byteLength(baseText) },
  }
  res.byteIdentical = candText === baseText
  let ja
  let jb
  try {
    ja = JSON.parse(candText)
    jb = JSON.parse(baseText)
  } catch (err) {
    res.outputIdentical = false
    res.first = { at: '(not JSON)', candidate: String(err.message) }
    return res
  }
  if (ja.error || jb.error) res.errors = { candidate: ja.error ?? null, base: jb.error ?? null }
  res.ok = { candidate: ja.ok ?? null, base: jb.ok ?? null }
  if (res.byteIdentical) {
    res.outputIdentical = true
    return res
  }
  let offset = 0
  while (offset < candText.length && candText[offset] === baseText[offset]) offset++
  res.offset = offset
  res.outputIdentical =
    JSON.stringify(core(ja.guide)) === JSON.stringify(core(jb.guide)) &&
    JSON.stringify(ja.apimodel) === JSON.stringify(jb.apimodel) &&
    ja.ok === jb.ok && JSON.stringify(ja.steps) === JSON.stringify(jb.steps) && ja.error === jb.error
  res.first = res.outputIdentical
    ? firstDifference(ja, jb)
    : firstDifference({ ...ja, guide: core(ja.guide) }, { ...jb, guide: core(jb.guide) })
  return res
}

async function compare(opts, wt, report) {
  log('6. apidef\'s guide and model, candidate against base')
  const list = definitions(opts, wt)
  const outDir = Path.join(workDir, 'models')
  const logDir = Path.join(workDir, 'logs')
  Fs.mkdirSync(outDir)
  Fs.mkdirSync(logDir)
  const fromDef = list.filter((d) => d.label.startsWith('apidef ')).length
  log(`   ${list.length} definitions: ${fromDef} OpenAPI descriptions in apidef's ts/test/def/, ` +
    `2 from test/petstore/, ${opts.extra.length} --extra; ${opts.jobs} runs at a time, ${opts.timeout}s each`)

  const jobs = []
  list.forEach((item, i) => {
    for (const side of ['candidate', 'base']) jobs.push({ item, i, side })
  })
  const results = new Map()
  let finished = 0
  const t0 = Date.now()
  status = () => `models: ${finished} of ${jobs.length} runs (${pct(finished, jobs.length)})`
  const tick = setInterval(() => log('   ' + status() + `, ${secs(Date.now() - t0)}`), 10000)

  const one = async ({ item, i, side }) => {
    const tag = `${String(i).padStart(3, '0')}-${side}`
    const out = Path.join(outDir, tag + '.json')
    const scratch = Path.join(workDir, 'scratch', tag)
    Fs.mkdirSync(scratch, { recursive: true })
    const tsdir = Path.join('candidate' === side ? wt.cand : wt.base, 'ts')
    const r = await run(process.execPath,
      ['--max-old-space-size=4096', Path.join(HELPERS, 'model.cjs'), tsdir, item.file, out, scratch],
      { cwd: scratch, env: childEnv(), timeoutMs: opts.timeout * 1000 })
    Fs.writeFileSync(Path.join(logDir, tag + '.log'), r.out + r.err)
    Fs.rmSync(scratch, { recursive: true, force: true })
    let text = null
    try {
      text = Fs.readFileSync(out, 'utf8')
    } catch {
      // No output: reported below.
    }
    const why = r.timedOut ? `timed out after ${opts.timeout}s`
      : null == text ? `no output (exit ${r.code ?? r.signal}): ${r.err.trim().split('\n').pop() ?? ''}` : null
    results.set(tag, { text, why })
    finished++
  }
  const queue = jobs.slice()
  await Promise.all(Array.from({ length: opts.jobs }, async () => {
    while (0 < queue.length) await one(queue.shift())
  }))
  clearInterval(tick)
  log(`   ${jobs.length} runs in ${secs(Date.now() - t0)}`)

  const rows = []
  list.forEach((item, i) => {
    const c = results.get(`${String(i).padStart(3, '0')}-candidate`)
    const b = results.get(`${String(i).padStart(3, '0')}-base`)
    if (c.why || b.why) {
      rows.push({ label: item.label, compared: false, candidate: c.why, base: b.why })
      return
    }
    rows.push({ compared: true, ...compareOne(item, c.text, b.text) })
  })

  const compared = rows.filter((r) => r.compared)
  const identical = compared.filter((r) => r.byteIdentical)
  const coreOnly = compared.filter((r) => !r.byteIdentical && r.outputIdentical)
  const differ = compared.filter((r) => !r.outputIdentical)
  const notCompared = rows.filter((r) => !r.compared)
  const bothFailed = identical.filter((r) => r.errors)
  report.compare = {
    definitions: rows.length,
    compared: compared.length,
    byteIdentical: identical.length,
    differOnlyInInputCopies: coreOnly.length,
    differ: differ.length,
    notCompared: notCompared.length,
    ms: Date.now() - t0,
    rows: rows.map((r) => ({ ...r })),
  }
  log(`   ${compared.length} of ${rows.length} compared: ${identical.length} byte-identical, ` +
    `${coreOnly.length} differ only in the guide's copies of the input, ${differ.length} differ in apidef's output, ` +
    `${notCompared.length} not compared`)
  for (const r of bothFailed) log(`   note: identical, but both sides failed in apidef: ${r.label}: ${r.errors.base}`)
  const notOk = identical.filter((r) => !r.errors && true !== r.ok?.base)
  for (const r of notOk) log(`   note: identical, but apidef reported ok ${r.ok?.base} on both sides: ${r.label}`)
  for (const r of coreOnly) {
    log(`   differs only in the guide's copies of the input: ${r.label}`)
    log(`     first at ${r.first?.at} (character ${r.offset}): candidate ${r.first?.candidate}, base ${r.first?.base}`)
  }
  for (const r of differ) {
    log(`   DIFFERS: ${r.label}`)
    log(`     first at ${r.first?.at} (character ${r.offset}): candidate ${r.first?.candidate}`)
    log(`                                   base      ${r.first?.base}`)
  }
  for (const r of notCompared) {
    log(`   NOT COMPARED: ${r.label}: ` + [r.candidate && 'candidate ' + r.candidate, r.base && 'base ' + r.base].filter(Boolean).join('; '))
  }
  if (0 < differ.length + coreOnly.length + notCompared.length) {
    report.reasons.push(`${rows.length - identical.length} of ${rows.length} definitions are not byte-identical in apidef's output`)
    return false
  }
  return true
}

// ---- cleanup ----

let cleaned = false

function cleanup(opts) {
  if (cleaned) return
  cleaned = true
  for (const c of children) c.kill('SIGKILL')
  if (opts.keep) {
    if (workDir) {
      log(`kept: ${workDir}`)
      for (const dir of worktrees) log(`  remove with: git -C ${opts.apidef} worktree remove --force ${dir}`)
    }
    return
  }
  for (const dir of worktrees) {
    // The link first, so that nothing removing the worktree can reach
    // through it into apidef's node_modules.
    const link = Path.join(dir, 'ts', 'node_modules')
    try {
      if (Fs.lstatSync(link).isSymbolicLink()) Fs.unlinkSync(link)
    } catch {
      // Not made.
    }
    try {
      gitSync(opts.apidef, 'worktree', 'remove', '--force', dir)
    } catch (err) {
      log(`warning: git worktree remove ${dir} failed: ${String(err.stderr ?? err.message).trim()}`)
    }
  }
  tryGit(opts.apidef, 'worktree', 'prune')
  if (workDir) {
    for (const sub of ['models', 'logs', 'scratch', 'candidate', 'base']) {
      Fs.rmSync(Path.join(workDir, sub), { recursive: true, force: true })
    }
    if (workMade) Fs.rmSync(workDir, { recursive: true, force: true })
  }
}

// ---- main ----

async function main() {
  const opts = readArgs(process.argv.slice(2))
  const report = { gate: 'apidef', started: new Date(started).toISOString(), reasons: [] }
  const onSignal = (sig) => {
    log(`\napidef-gate: ${sig}, cleaning up`)
    cleanup(opts)
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  log(`apidef gate: apidef at ${opts.apidef} against this checkout's ts/ (${TS})`)
  let code
  let imports = false
  try {
    if (!ground(opts, report)) code = 2
    else if (!(await buildOwn(opts, report))) code = 1
    else {
      const wt = await prepare(opts, report)
      if (null == wt) code = 1
      else {
        const linked = await copies(opts, wt, report)
        imports = true === report.copies?.candidate?.importsOpenapi
        if (!linked) code = 1
        else {
          const tested = await suite(opts, wt, report)
          const same = await compare(opts, wt, report)
          code = tested && same ? (imports ? 0 : 3) : 1
        }
      }
    }
  } catch (err) {
    const unready = err instanceof GroundError
    report.reasons.push(String(err.message))
    log(`FAIL: ${err.message}`)
    if (!unready) log(String(err.stack))
    code = unready ? 2 : 1
  } finally {
    cleanup(opts)
  }

  if (3 === code) {
    report.reasons.push(`apidef at ${report.mode.candidate.commit.slice(0, 7)} does not import @tabnas/openapi, so the run proves nothing about this package`)
  }
  report.result = { 0: 'pass', 1: 'fail', 2: 'could not run', 3: 'inconclusive' }[code]
  report.exit = code
  report.ms = Date.now() - started
  const s = report.suite
  const c = report.compare
  log('')
  log('apidef gate summary')
  if (report.mode) {
    log(`  apidef ${report.mode.candidate.commit.slice(0, 7)}` +
      (report.mode.patch ? ` with ${report.mode.patch}` : '') +
      `, against ${report.mode.base.commit.slice(0, 7)} ${report.mode.base.ref}`)
  }
  if (s?.ran) {
    log(`  suite: ${s.tests} tests, ${s.passed} pass, ${s.failed} fail, ${s.skipped} skipped` +
      (s.cancelled ? `, ${s.cancelled} cancelled` : '') +
      ` (${opts.allowFailures} ${1 === opts.allowFailures ? 'failure' : 'failures'} allowed)`)
    for (const f of s.failures.slice(0, 10)) log(`    failing: ${f.name}`)
    if (10 < s.failures.length) log(`    and ${s.failures.length - 10} more, named above`)
  }
  if (c) {
    log(`  output: ${c.byteIdentical} of ${c.definitions} definitions byte-identical` +
      (c.definitions === c.byteIdentical ? '' : `; ${c.differ} differ, ${c.differOnlyInInputCopies} differ only in the guide's input copies, ${c.notCompared} not compared`))
  }
  if (report.copies?.candidate) {
    log(`  @tabnas/openapi: ${report.copies.candidate.resolved ?? 'not resolved'}, ` +
      (imports ? 'imported by apidef' : 'NOT imported by apidef at this commit: this run proves nothing about this package'))
  }
  for (const r of report.reasons) log(`  - ${r}`)
  log(`  result: ${report.result}, exit ${code}, ${secs(report.ms)}`)
  if (opts.report) {
    Fs.writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n')
    log(`  report: ${opts.report}`)
  }
  clearInterval(heartbeat)
  return code
}

// The code that decides what a description is and whether two outputs
// differ, for ts/test/apidef-gate.test.ts: a comparison that stopped
// seeing a difference would report a regression as identical.
module.exports = { readArgs, isDescription, core, firstDifference, compareOne }

if (require.main === module) {
  main().then((code) => process.exit(code))
}
