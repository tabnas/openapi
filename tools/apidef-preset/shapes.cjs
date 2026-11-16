/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/shapes.cjs: the hand-written edge shapes, from
// shapes.json beside it, as document texts. See that file's `about` for
// the shorthand a shape may use.
//
// A module for apidef-preset.cjs; it runs nothing by itself.

const Fs = require('node:fs')
const Path = require('node:path')

const FILE = Path.join(__dirname, 'shapes.json')

const VERSIONS = { '2.0': '2.0', '3.0': '3.0.3', '3.1': '3.1.0', '3.2': '3.2.0', none: null }

// A document from a shape's shorthand. `#S/` in a string is the schemas'
// pointer for the version.
function docOf(shape) {
  const v = shape.v ?? '3.0'
  if (!Object.prototype.hasOwnProperty.call(VERSIONS, v)) throw new Error(`shape ${shape.name}: unknown version ${v}`)
  const doc = {}
  if (null != VERSIONS[v]) doc['2.0' === v ? 'swagger' : 'openapi'] = VERSIONS[v]
  doc.info = { title: 't', version: '1' }
  doc.paths = shape.paths ?? {}
  if ('2.0' === v) {
    if (shape.schemas) doc.definitions = shape.schemas
  } else if (shape.schemas || shape.components) {
    doc.components = { ...(shape.components ?? {}) }
    if (shape.schemas) doc.components.schemas = shape.schemas
  }
  if ('2.0' === v && shape.components) Object.assign(doc, shape.components)
  for (const k of Object.keys(shape.extra ?? {})) {
    Object.defineProperty(doc, k, { value: shape.extra[k], enumerable: true, writable: true, configurable: true })
  }
  const base = '2.0' === v ? '#/definitions/' : '#/components/schemas/'
  return JSON.parse(JSON.stringify(doc).split('#S/').join(base))
}

function textOf(shape) {
  if ('string' === typeof shape.yaml) return shape.yaml
  if (null != shape.doc) return JSON.stringify(shape.doc)
  return JSON.stringify(docOf(shape))
}

function loadShapes(file = FILE) {
  const { shapes } = JSON.parse(Fs.readFileSync(file, 'utf8'))
  const names = new Set()
  return shapes.map((s) => {
    if (names.has(s.name)) throw new Error(`${file}: shape ${s.name} named twice`)
    names.add(s.name)
    return { name: s.name, note: s.note ?? '', text: textOf(s) }
  })
}

module.exports = { loadShapes, docOf, textOf, FILE }
