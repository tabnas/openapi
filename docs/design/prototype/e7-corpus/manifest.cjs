#!/usr/bin/env node
'use strict'
// Build the corpus manifest: one JSON line per distinct document.
// usage: node manifest.cjs > manifest.jsonl
const Fs = require('node:fs'), Path = require('node:path'), Crypto = require('node:crypto')
// CORPUS_SRC: the folder the sources of the README were cloned into.
// CORPUS_EXTRA: optional, a folder holding census/github.json,
// real-spec-dl/spec3.json and census/oai/ fetched by hand.
const SRC = process.env.CORPUS_SRC
if (!SRC) { console.error('set CORPUS_SRC to the folder holding the cloned sources'); process.exit(2) }
const S = process.env.CORPUS_EXTRA || ''
function walk(dir, ok, out = []) {
  for (const e of Fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.github') continue
    const p = Path.join(dir, e.name)
    if (e.isDirectory()) walk(p, ok, out)
    else if (e.isFile() && ok(p)) out.push(p)
  }
  return out
}
const dataExt = (p) => /\.(ya?ml|json)$/i.test(p)
const sets = [
  ['apis-guru', walk(SRC + '/oad/APIs', (p) => /\/(openapi|swagger)\.yaml$/.test(p))],
  ['oai-tests-3.1', walk(SRC + '/oas-v3.1-dev/tests/schema', dataExt)],
  ['oai-tests-3.2', walk(SRC + '/oas-v3.2-dev/tests/schema', dataExt)],
  ['oai-tests-3.3', walk(SRC + '/oas-v3.3-dev/tests/schema', dataExt)],
  ['oai-archive-3.0', walk(SRC + '/OpenAPI-Specification/_archive_/schemas/v3.0/pass', dataExt)],
  ['oai-learn', walk(SRC + '/learn.openapis.org/examples', dataExt)],
  ['oai-learn-other', [...walk(SRC + '/learn.openapis.org/referencing', dataExt), ...walk(SRC + '/learn.openapis.org/overlay', dataExt), ...walk(SRC + '/learn.openapis.org/tests', dataExt)]],
  ['digitalocean', walk(SRC + '/do-openapi/specification', dataExt)],
  ['redocly-starter', walk(SRC + '/openapi-starter/openapi', dataExt)],
  ['github', walk(SRC + '/rest-api-description/descriptions', dataExt).concat(walk(SRC + '/rest-api-description/descriptions-next', dataExt))],
  ['stripe', walk(SRC + '/stripe-openapi/latest', dataExt)],
  ['azure', walk(SRC + '/azure-rest-api-specs/specification', dataExt)],
  ['preexisting', S ? [S + '/census/github.json', S + '/real-spec-dl/spec3.json', ...walk(S + '/census/oai', dataExt)] : []],
]
const seen = new Map()
let n = 0
for (const [source, files] of sets) {
  for (const path of files.sort()) {
    const buf = Fs.readFileSync(path)
    const sha1 = Crypto.createHash('sha1').update(buf).digest('hex')
    const rec = { id: 'd' + String(++n).padStart(5, '0'), source, path, size: buf.length, sha1 }
    if (seen.has(sha1)) rec.dupOf = seen.get(sha1)
    else seen.set(sha1, rec.id)
    process.stdout.write(JSON.stringify(rec) + '\n')
  }
}
