/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/sources.cjs: the corpus's sources and its documents.
//
// Reads sources.json beside it, says where each source is checked out,
// whether a checkout is at its pinned commit, and which of its files are
// documents. `manifest` lists every document once: a file identical (by
// SHA-1) to an earlier one is marked `dupOf` that one and not swept. The
// order is the order of sources.json, then path order within a source, so
// which copy of a duplicated file counts is stable.
//
// A module for fetch.cjs and sweep.cjs; it runs nothing by itself.

const Fs = require('node:fs')
const Path = require('node:path')
const Crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ROOT = Path.join(__dirname, '..', '..')
const SOURCES_FILE = Path.join(__dirname, 'sources.json')

// Where the checkouts live: CORPUS_DIR, or .corpus/src in this repository.
const corpusDir = () => Path.resolve(process.env.CORPUS_DIR || Path.join(ROOT, '.corpus', 'src'))

function loadSources(file = SOURCES_FILE) {
  const { sources } = JSON.parse(Fs.readFileSync(file, 'utf8'))
  const names = new Set()
  for (const s of sources) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(s.name)) throw new Error(`sources.json: bad source name ${JSON.stringify(s.name)}`)
    if (names.has(s.name)) throw new Error(`sources.json: source ${s.name} named twice`)
    names.add(s.name)
    if (!/^[0-9a-f]{40}$/.test(s.commit)) throw new Error(`sources.json: ${s.name}: commit must be a full SHA-1`)
    if (!/^[\w.-]+\/[\w.-]+$/.test(s.repository)) throw new Error(`sources.json: ${s.name}: repository must be owner/name`)
  }
  return sources
}

const sourceDir = (s, dir = corpusDir()) => Path.join(dir, s.name)

// The sparse-checkout file a source needs, or null for a whole checkout.
function sparseOf(s) {
  const c = s.checkout
  if ('whole' === c) return null
  if (c.cone) return { cone: true, lines: ['/*', '!/*/', ...c.cone.map((p) => '/' + p.replace(/^\/|\/$/g, '') + '/')] }
  if (c.patterns) return { cone: false, lines: c.patterns.slice() }
  if (c.files) return { cone: false, lines: c.files.map((f) => '/' + f.replace(/^\//, '')) }
  throw new Error(`sources.json: ${s.name}: unknown checkout ${JSON.stringify(c)}`)
}

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// The commit a checkout is at, or null when there is no checkout there.
function headOf(dir) {
  if (!Fs.existsSync(Path.join(dir, '.git'))) return null
  try { return git(dir, ['rev-parse', 'HEAD']) } catch { return null }
}

// Whether a checkout is the pinned commit, checked out as sources.json says.
function isCurrent(s, dir = sourceDir(s)) {
  if (headOf(dir) !== s.commit) return false
  const want = sparseOf(s)
  const file = Path.join(dir, '.git', 'info', 'sparse-checkout')
  let enabled = 'false'
  try { enabled = git(dir, ['config', '--get', 'core.sparseCheckout']) } catch {}
  if (null == want) return 'true' !== enabled
  if ('true' !== enabled || !Fs.existsSync(file)) return false
  return Fs.readFileSync(file, 'utf8').trim() === want.lines.join('\n')
}

// Every file of a source that is a document, as paths relative to its checkout, sorted.
function documentsOf(s, dir = sourceDir(s)) {
  const match = new RegExp(s.documents.match)
  const out = []
  const walk = (rel) => {
    const abs = Path.join(dir, rel)
    if (!Fs.existsSync(abs)) return
    for (const e of Fs.readdirSync(abs, { withFileTypes: true })) {
      if ('.git' === e.name || 'node_modules' === e.name || '.github' === e.name) continue
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && match.test(r)) out.push(r)
    }
  }
  for (const root of s.documents.roots) walk(root)
  return [...new Set(out)].sort()
}

const sha1 = (buf) => Crypto.createHash('sha1').update(buf).digest('hex')

// The SHA-1 of the code under a folder: every .js, .cjs and .mjs file, by
// its path within the folder and its content, in path order. A
// `node_modules` folder is left out, since what the code depends on is
// hashed as itself.
function codeHash(dir) {
  const hash = Crypto.createHash('sha1')
  const walk = (rel) => {
    const entries = Fs.readdirSync(Path.join(dir, rel), { withFileTypes: true })
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if ('node_modules' === e.name || '.git' === e.name) continue
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && /\.[cm]?js$/.test(e.name)) hash.update(r + '\0').update(Fs.readFileSync(Path.join(dir, r))).update('\0')
    }
  }
  walk('')
  return hash.digest('hex')
}

// One record per file: { id, source, path, file, size, dupOf? }. `id` is
// the file's SHA-1, so a record names the same bytes in every run.
// `progress(source, index, files)` is called as each source starts, and
// `tick(filesRead)` after each file, so a caller can report while a large
// source is read.
function manifest(sources, dir = corpusDir(), progress = () => {}, tick = () => {}) {
  const seen = new Set()
  const out = []
  sources.forEach((s, i) => {
    const files = documentsOf(s, sourceDir(s, dir))
    progress(s, i, files.length)
    for (const path of files) {
      tick(out.length)
      const file = Path.join(sourceDir(s, dir), path)
      const buf = Fs.readFileSync(file)
      const id = sha1(buf)
      const rec = { id, source: s.name, path, file, size: buf.length }
      if (seen.has(id)) rec.dupOf = id
      else seen.add(id)
      out.push(rec)
    }
  })
  return out
}

// Files and distinct documents per source, against sources.json. A
// distinct count depends on the sources before it, so a partial list
// checks files alone.
function countCheck(sources, records, { distinct: checkDistinct = true } = {}) {
  const problems = []
  for (const s of sources) {
    const mine = records.filter((r) => r.source === s.name)
    const distinct = mine.filter((r) => !r.dupOf).length
    if (mine.length !== s.files || (checkDistinct && distinct !== s.distinct)) {
      problems.push(`${s.name}: ${mine.length} files and ${distinct} distinct documents, where sources.json expects ${s.files} and ${s.distinct}`)
    }
  }
  return problems
}

module.exports = { ROOT, SOURCES_FILE, corpusDir, loadSources, sourceDir, sparseOf, headOf, isCurrent, documentsOf, manifest, countCheck, sha1, codeHash }
