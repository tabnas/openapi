#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/documents.cjs: the corpus's descriptions in several
// documents, each resolved from its own file.
//
// The sweep resolves one document at a time, so a reference into another
// document is `external` there. This run is the other half. For each
// source it takes every file that is a description, resolves it with
// `resolveAll` and the file loader, confined to the source's folder, and
// counts what it loaded and what is left as written. A reference that is
// left as external is then looked for on disk: one whose document is
// there and was not read is the failure this run exists to find.
//
// It then writes each description as one document, with `bundleAll` and
// the same loader, and holds the bundle to its documents: the bundle has
// to resolve to what they resolve to, which bundle-agree.cjs checks. A
// bundle that does not is the other failure.
//
// Run from the repository root, after `npm run build` in ts/ and the
// corpus fetch, under the Node version `engines` in ts/package.json names:
//
//   node tools/corpus/documents.cjs            run, and compare with test/corpus/documents.json
//   node tools/corpus/documents.cjs --write    run, and rewrite that file
//   node tools/corpus/documents.cjs --only azure,redocly-starter
//
// It takes about a minute, and prints a line at least every 15 seconds.
// Exit status: 0 when the figures are the recorded ones, or were written;
// 1 when one moved, a description threw, a document on disk was left
// unread, or a bundle does not agree with its documents; 2 when it could
// not run.
//
// DigitalOcean's source is run under `slots: 'all'`: its entry names a
// file for each operation, where 3.0 has no Reference Object.

const Fs = require('node:fs')
const Path = require('node:path')
const Url = require('node:url')

const ROOT = Path.join(__dirname, '..', '..')
const RECORD = Path.join(ROOT, 'test', 'corpus', 'documents.json')
const CORPUS = process.env.CORPUS_DIR || Path.join(ROOT, '.corpus', 'src')
const DIST = process.env.OPENAPI_DIST || Path.join(ROOT, 'ts', 'dist')

// The sources that have descriptions in several documents, and the
// options each is resolved under.
const SOURCES = [
  { name: 'azure', options: {} },
  { name: 'redocly-starter', options: {} },
  { name: 'oai-learn', options: {} },
  { name: 'digitalocean', options: { slots: 'all' } },
]

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
if (flag('-h') || flag('--help')) {
  console.log('usage: node tools/corpus/documents.cjs [--write] [--only <source>,<source>]')
  process.exit(0)
}
const fail = (msg) => {
  console.error('documents: ' + msg)
  process.exit(2)
}
if (!Fs.existsSync(Path.join(DIST, 'openapi.js'))) fail('no build at ' + DIST + ': run npm run build in ts/')
const only = valueOf('--only')?.split(',')
for (const name of only ?? []) if (!SOURCES.some((s) => s.name === name)) fail(name + ' is not a source this run takes')

const O = require(Path.join(DIST, 'openapi.js'))
const U = require(Path.join(DIST, 'uri.js'))
const { fileLoader } = require(Path.join(DIST, 'loaders.js'))
const { agree } = require('./bundle-agree.cjs')

const t0 = Date.now()
let last = t0
const beat = (line) => {
  if (15000 <= Date.now() - last) {
    last = Date.now()
    console.log(`   ${line}, ${Math.round((last - t0) / 1000)}s`)
  }
}

function filesUnder(dir) {
  const out = []
  const walk = (d) => {
    for (const e of Fs.readdirSync(d, { withFileTypes: true })) {
      const p = Path.join(d, e.name)
      if (e.isDirectory()) {
        if ('.git' !== e.name) walk(p)
      } else if (/\.(json|ya?ml)$/i.test(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

async function run(source, done, all) {
  const dir = Path.join(CORPUS, source.name)
  if (!Fs.existsSync(dir)) fail('no checkout of ' + source.name + ' under ' + CORPUS + ': run node tools/corpus/fetch.cjs')
  const files = filesUnder(dir)
  const figures = {
    options: source.options,
    files: files.length,
    descriptions: 0,
    inSeveralDocuments: 0,
    documentsLoaded: 0,
    mostDocumentsForOne: 0,
    sites: 0,
    resolved: 0,
    cut: 0,
    unresolved: {},
    threw: 0,
    externalOnDisk: 0,
    // The same descriptions, each written as one document.
    bundle: { agree: 0, differ: 0, threw: 0, component: 0, defs: 0, inline: 0, left: {}, dialects: 0 },
  }
  const trouble = []
  for (let i = 0; i < files.length; i++) {
    beat(`${source.name}: ${i} of ${files.length} files (${Math.round((100 * (done + i)) / all)}% of the run)`)
    let raw
    try {
      raw = O.parse(Fs.readFileSync(files[i]))
    } catch {
      continue
    }
    if ('unknown' === O.version(raw).version) continue
    figures.descriptions++
    const rel = Path.relative(dir, files[i])
    // A file is read once for one description, however often it is asked for.
    const read = fileLoader({ root: dir })
    const had = new Map()
    const load = (uri) => {
      if (!had.has(uri)) had.set(uri, read(uri))
      return had.get(uri)
    }
    const options = { retrievalUri: Url.pathToFileURL(files[i]).href, load, ...source.options }
    let r
    try {
      r = await O.resolveAll(raw, options)
    } catch (err) {
      figures.threw++
      trouble.push(`${source.name}/${rel}: threw ${err.code ?? ''} ${String(err.message).slice(0, 160)}`)
      continue
    }
    if (0 < r.documents.length) figures.inSeveralDocuments++
    figures.documentsLoaded += r.documents.length
    figures.mostDocumentsForOne = Math.max(figures.mostDocumentsForOne, r.documents.length)
    figures.sites += r.provenance.length
    for (const p of r.provenance) {
      if ('resolved' === p.status) figures.resolved++
      else if ('cut' === p.status) figures.cut++
      if (undefined === p.uri) continue
      let there = false
      try {
        there = p.uri.startsWith('file:') && Fs.existsSync(Url.fileURLToPath(p.uri))
      } catch {
        there = false
      }
      if (there) {
        figures.externalOnDisk++
        trouble.push(`${source.name}/${rel}: ${p.at} names ${p.uri}, which is on disk and was not read`)
      }
    }
    for (const u of r.unresolved) figures.unresolved[u.why] = (figures.unresolved[u.why] ?? 0) + 1

    const b = figures.bundle
    let held
    try {
      held = await agree(O, U, raw, options)
    } catch (err) {
      b.threw++
      trouble.push(`${source.name}/${rel}: bundling threw ${err.code ?? ''} ${String(err.message).slice(0, 160)}`)
      continue
    }
    if (held.ok) b.agree++
    else {
      b.differ++
      trouble.push(`${source.name}/${rel}: its bundle does not resolve to what its documents do: ${held.why.slice(0, 2).join('; ').slice(0, 300)}`)
    }
    for (const e of held.bundle.embedded) b[e.as]++
    for (const l of held.bundle.left) b.left[l.why] = (b.left[l.why] ?? 0) + 1
    b.dialects += held.bundle.dialects.length
  }
  return { figures, trouble, files: files.length }
}

;(async () => {
  const sources = SOURCES.filter((s) => !only || only.includes(s.name))
  const counts = sources.map((s) => (Fs.existsSync(Path.join(CORPUS, s.name)) ? filesUnder(Path.join(CORPUS, s.name)).length : 0))
  const all = counts.reduce((a, b) => a + b, 0)
  const found = {}
  const trouble = []
  let done = 0
  for (const [i, source] of sources.entries()) {
    const r = await run(source, done, all)
    done += counts[i]
    found[source.name] = r.figures
    trouble.push(...r.trouble)
    const f = r.figures
    const left = Object.entries(f.unresolved).map(([why, n]) => `${why} ${n}`).join(', ') || 'none'
    console.log(
      `${source.name}: ${f.descriptions} descriptions, ${f.inSeveralDocuments} in several documents; ` +
        `${f.documentsLoaded} documents loaded, ${f.mostDocumentsForOne} at most for one; ` +
        `${f.sites} sites: ${f.resolved} resolved, ${f.cut} cut; left as written: ${left}; ` +
        `${f.threw} threw, ${f.externalOnDisk} on disk and not read`,
    )
    const b = f.bundle
    const stays = Object.entries(b.left).map(([why, n]) => `${why} ${n}`).join(', ') || 'none'
    console.log(
      `  as one document: ${b.agree} agree with their documents, ${b.differ} do not, ${b.threw} threw; ` +
        `${b.component} targets among the components, ${b.defs} in the $defs of a resource, ${b.inline} in the place of a reference; ` +
        `left: ${stays}; ${b.dialects} schemas given a $schema`,
    )
  }
  for (const line of trouble.slice(0, 20)) console.log('  ' + line)
  if (20 < trouble.length) console.log(`  and ${trouble.length - 20} more`)

  let exit = 0 < trouble.length ? 1 : 0
  const record = Fs.existsSync(RECORD) ? JSON.parse(Fs.readFileSync(RECORD, 'utf8')) : { sources: {} }
  if (flag('--write')) {
    if (0 !== exit) console.log('documents: not written, since a description threw, a document on disk was left unread or a bundle does not agree')
    else {
      const next = {
        note: 'What tools/corpus/documents.cjs counts: each description of these corpus sources resolved from its own file with resolveAll and the file loader, confined to the source, and then written as one document with bundleAll and held to its documents. Written by that tool, never by hand.',
        sources: { ...(record.sources ?? {}), ...found },
      }
      Fs.writeFileSync(RECORD, JSON.stringify(next, null, 2) + '\n')
      console.log('documents: wrote ' + Path.relative(ROOT, RECORD))
    }
  } else {
    for (const [name, figures] of Object.entries(found)) {
      const was = record.sources?.[name]
      if (JSON.stringify(was) !== JSON.stringify(figures)) {
        exit = 1
        if (undefined === was) console.log(`documents: ${name} has no record`)
        else {
          for (const key of new Set([...Object.keys(was), ...Object.keys(figures)])) {
            if (JSON.stringify(was[key]) !== JSON.stringify(figures[key])) {
              console.log(`documents: ${name}: ${key} moved: ${JSON.stringify(was[key])} -> ${JSON.stringify(figures[key])}`)
            }
          }
        }
      }
    }
    if (0 === exit) console.log('documents: the figures are the ones recorded')
  }
  console.log(`documents: ${sources.length} sources in ${Math.round((Date.now() - t0) / 1000)}s, exit ${exit}`)
  process.exit(exit)
})()
