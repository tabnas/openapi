#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: what a widely used resolver gives for the references of the corpus
// that pass a site, and for the W1 and W2 shapes.
//
//   REF_PARSER=<folder with @apidevtools/json-schema-ref-parser installed> \
//   node second-opinion.cjs
//
// This repository declares no dependency on that package. It is installed
// in a scratch folder, as the reference YAML parser was for E7, and
// REF_PARSER names that folder. Each document is read with this package's
// `parse` and handed over as a plain tree, so nothing else is read from
// disk and no other document is fetched.

const Fs = require('node:fs')
const Path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = Path.join(__dirname, '..', '..', '..', '..')
const O = require(process.env.OPENAPI_DIST || Path.join(ROOT, 'ts', 'dist', 'openapi.js'))
if (null == process.env.REF_PARSER) {
  console.error('second-opinion.cjs: set REF_PARSER to a folder with @apidevtools/json-schema-ref-parser installed')
  process.exit(2)
}
const fromThere = createRequire(Path.join(Path.resolve(process.env.REF_PARSER), 'package.json'))
const $RefParser = fromThere('@apidevtools/json-schema-ref-parser')
const VERSION = fromThere('@apidevtools/json-schema-ref-parser/package.json').version

const CORPUS = process.env.CORPUS_SRC || Path.join(ROOT, '.corpus', 'src')
const plain = (v) => JSON.parse(JSON.stringify(v))
const J = (v) => {
  let s
  try {
    s = JSON.stringify(v)
  } catch {
    s = '[a cycle]'
  }
  return undefined === s ? 'undefined' : 160 < s.length ? s.slice(0, 157) + '...' : s
}
const at = (root, pointer) => {
  let node = root
  for (const seg of pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (null == node) return undefined
    node = node[seg]
  }
  return node
}
const dereference = (doc) => $RefParser.dereference(doc, { resolve: { external: false }, dereference: { circular: 'ignore' } })

const DOCUMENTS = [
  ['apis-guru/APIs/dnd5eapi.co/0.1/openapi.yaml', [
    '/components/schemas/Monster/allOf/3/properties/actions/items/properties/attacks/items/properties/damage',
    '/components/schemas/Monster/allOf/3/properties/special_abilities/items/properties/damage/items',
    '/components/schemas/Monster/allOf/3/properties/special_abilities/items/properties/spellcasting/properties/spells/items/properties/usage',
  ]],
  ['apis-guru/APIs/codat.io/sync-for-commerce/1.1/openapi.yaml', [
    '/components/schemas/Branding/properties/button/properties/default',
    '/components/schemas/Branding/properties/button/properties/hover',
    '/components/schemas/Branding/properties/logo/properties/square',
  ]],
]

const S = (schemas, version = '3.0.3') => ({ openapi: version, info: { title: 't', version: '1' }, paths: {}, components: { schemas } })
const SHAPES = [
  ['W1, a member the reference has as written', S({
    A: { properties: { x: { type: 'string' } } },
    B: { $ref: '#/components/schemas/A', properties: { x: { type: 'integer' } } },
    C: { $ref: '#/components/schemas/B/properties/x' },
  })],
  ['W1, a member only the target has', S({
    A: { properties: { y: { type: 'string' } } },
    B: { $ref: '#/components/schemas/A' },
    C: { $ref: '#/components/schemas/B/properties/y' },
  })],
  ['W2, a schema that references its own $defs', S({
    B: { $ref: '#/components/schemas/B/$defs/x', $defs: { x: { type: 'string' } } },
    C: { $ref: '#/components/schemas/B' },
  }, '3.1.0')],
]

;(async () => {
  console.log(`@apidevtools/json-schema-ref-parser ${VERSION}\n`)
  for (const [file, sites] of DOCUMENTS) {
    const raw = plain(O.parse(Fs.readFileSync(Path.join(CORPUS, file), 'utf8')))
    console.log(file)
    try {
      const out = await dereference(raw)
      for (const s of sites) console.log(`   ${s}\n      ${J(at(out, s))}`)
    } catch (e) {
      console.log('   throws ' + (e?.name ?? 'Error') + ': ' + String(e?.message ?? e).split('\n')[0].slice(0, 160))
    }
  }
  console.log()
  for (const [name, doc] of SHAPES) {
    try {
      const out = await dereference(plain(doc))
      console.log(`${name}: C is ${J(out.components.schemas.C)}`)
    } catch (e) {
      console.log(`${name}: throws ${e?.name ?? 'Error'}`)
    }
  }
})()
