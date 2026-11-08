/* Copyright (c) 2025-2026 Richard Rodger and other contributors, MIT License */

// Composition test: the OpenAPI plugin layered with the official
// @tabnas/debug plugin. @tabnas/debug is a devDependency, but this still
// resolves it dynamically and SKIPS when it is absent so the suite stays
// runnable outside the package; TABNAS_DEBUG_PATH can point at a sibling
// checkout's built plugin.
//
// Raw mode is the engine's own parse, so the plugin must add no grammar:
// the model of `make()` is the model of jsonic with the yaml grammar, and
// the model of `make({ strict: true })` is the model of json alone.

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { Yaml } from '@tabnas/yaml'
import { json } from '@tabnas/json'
import { make } from '../dist/openapi'

function loadDebug(): any {
  const candidates = [process.env.TABNAS_DEBUG_PATH, '@tabnas/debug'].filter(
    Boolean,
  ) as string[]
  for (const c of candidates) {
    try {
      return require(c).Debug
    } catch {
      /* try next */
    }
  }
  return null
}

const Debug = loadDebug()
const skip = Debug
  ? false
  : '@tabnas/debug not available (set TABNAS_DEBUG_PATH)'

function model(tn: Tabnas): any {
  tn.use(Debug, { print: false, trace: false })
  return (tn as any).debug.model()
}

// The grammar portion of a model, as plain JSON.
function grammar(m: any): any {
  return JSON.parse(
    JSON.stringify({
      tokens: m.tokens,
      rules: m.rules,
      graph: m.graph,
      config: m.config,
      abnf: m.abnf,
    }),
  )
}

describe('compose: openapi + @tabnas/debug', () => {
  test('parses normally with the debug plugin installed', { skip }, () => {
    const tn = make()
    tn.use(Debug, { print: false, trace: false })
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(tn.parse('paths:\n  /pets: { get: {} }'))),
      { paths: { '/pets': { get: {} } } },
    )
  })

  test('the plugin adds no grammar to jsonic and yaml', { skip }, () => {
    const m = model(make())
    const base = model(new Tabnas().use(jsonic).use(Yaml))

    assert.ok(
      m.plugins.some((p: any) => p.name === 'OpenApi'),
      'plugins should list OpenApi',
    )
    assert.equal(m.config.start, 'stream')
    assert.deepStrictEqual(grammar(m), grammar(base))
  })

  test('the plugin adds no grammar to strict json', { skip }, () => {
    const m = model(make({ strict: true }))
    const base = model(new Tabnas().use(json))

    assert.ok(
      m.plugins.some((p: any) => p.name === 'OpenApi'),
      'plugins should list OpenApi',
    )
    assert.equal(m.config.start, 'val')
    assert.deepStrictEqual(
      m.rules.map((r: any) => r.name).sort(),
      ['elem', 'list', 'map', 'pair', 'val'],
    )
    assert.deepStrictEqual(grammar(m), grammar(base))
  })

  test('the grammar portion round-trips through JSON', { skip }, () => {
    const m = model(make())
    assert.deepStrictEqual(grammar(m).rules, JSON.parse(JSON.stringify(m.rules)))
  })
})
