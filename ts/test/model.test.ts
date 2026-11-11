/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The object model: the classifier against test/model/*.tsv, the committed
// generated files against their inputs, and every gate of the generator
// against an input it must refuse.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeRunner } from '@tabnas/support'

import { classify, slot, step, MODEL_VERSIONS } from '../dist/model'

// This file runs compiled from ts/dist-test; the repository root is two
// levels up.
const REPO = join(__dirname, '..', '..')

// What this test uses of tools/object-model.cjs, which is plain JavaScript
// loaded with require so that it stays outside the compilation.
type Generator = {
  generate(inputs?: { sources?: any; applicators?: any; overlay?: any }): any
  loadSources(read?: (file: string) => Buffer): any
  stale(): string[]
}

const Gen: Generator = require(join(REPO, 'tools', 'object-model.cjs'))

// RFC 6901: a pointer to its member names.
function fromPointer(pointer: string): string[] {
  if ('' === pointer) return []
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

makeRunner({
  input: 'path',
  expected: 'state',
  parse: (input, row) => classify(row.named('version') as any, fromPointer(input)).state,
}).dir(join(REPO, 'test', 'model'))

const overlay = () => JSON.parse(readFileSync(join(REPO, 'model', 'overlay.json'), 'utf8'))

describe('object model', () => {
  test('covers the four versions', () => {
    assert.deepEqual([...MODEL_VERSIONS].sort(), ['2.0', '3.0', '3.1', '3.2'])
  })

  test('the committed model is what its inputs generate', () => {
    assert.deepEqual(Gen.stale(), [])
  })

  test('a refable slot steps as the object it holds', () => {
    assert.equal(step('3.1', 'response?', 'content'), step('3.1', 'response', 'content'))
    assert.equal(slot('3.1', 'response?').target, 'response')
  })

  test('a list index may be a number or a string of digits', () => {
    const list = step('3.1', 'operation', 'parameters')
    assert.equal(step('3.1', list, 0), 'parameter?')
    assert.equal(step('3.1', list, '0'), 'parameter?')
    assert.equal(step('3.1', list, '01'), 'data')
    assert.equal(step('3.1', list, 'x'), 'data')
  })

  test('an unknown state is data, and an unknown version is refused', () => {
    assert.equal(slot('3.1', 'no-such-state').kind, 'data')
    assert.equal(step('3.1', 'no-such-state', 'a'), 'data')
    assert.throws(() => classify('4.0' as any, ['info']), /no object model for version "4.0"/)
  })

  test('a Security Requirement names security schemes by its member names', () => {
    assert.equal(classify('3.1', ['security', 0]).keys, 'connection:securityScheme')
  })

  test('the Schema Object carries its dialect', () => {
    assert.equal(classify('2.0', ['definitions', 'Pet']).dialect, 'draft-04')
    assert.equal(classify('3.0', ['components', 'schemas', 'Pet']).dialect, 'wright-00')
    assert.equal(classify('3.2', ['components', 'schemas', 'Pet']).dialect, '2020-12')
  })
})

describe('object model generator gates', () => {
  test('an overlay entry without a reason is refused', () => {
    const o = overlay()
    o.entries[0].reason = ' '
    assert.throws(() => Gen.generate({ overlay: o }), /has no reason/)
  })

  test('an overlay entry naming a state the model lacks is refused', () => {
    const o = overlay()
    o.entries[0].state = 'noSuchObject'
    assert.throws(() => Gen.generate({ overlay: o }), /has no state noSuchObject/)
  })

  test('an overlay entry naming a position the model lacks is refused', () => {
    const o = overlay()
    o.entries[0].at = ['noSuchMember']
    assert.throws(() => Gen.generate({ overlay: o }), /has no position noSuchMember/)
  })

  test('an overlay entry that matches no version is refused', () => {
    const o = overlay()
    o.entries[0].versions = ['9.9']
    assert.throws(() => Gen.generate({ overlay: o }), /matched no version/)
  })

  test('a vendored schema that does not match its pinned hash is refused', () => {
    const dir = join(REPO, 'model', 'schemas')
    const read = (file: string) => {
      const bytes = readFileSync(join(dir, file))
      return file.startsWith('oas-3.1-schema') ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes
    }
    assert.throws(() => Gen.loadSources(read), /does not match its pinned SHA-256/)
  })

  // The 3.1 schema, with the reference to the implicit flow changed.
  function refTo(ref: string) {
    const sources = structuredClone(Gen.loadSources())
    sources['3.1'].schema.doc.$defs['oauth-flows'].properties.implicit.$ref = ref
    return sources
  }

  test('a nested pointer is followed, and one that names nothing is refused', () => {
    assert.equal(classify('3.1', ['components', 'securitySchemes', 's', 'flows', 'password']).state, 'oauthFlow')
    const sources = refTo('#/$defs/oauth-flows/$defs/nope')
    assert.throws(() => Gen.generate({ sources }), /names no definition/)
  })

  test('a reference into a document the generator does not read is refused', () => {
    const sources = refTo('https://example.com/schema#/$defs/flow')
    assert.throws(() => Gen.generate({ sources }), /in a document the generator does not read/)
  })

  test('a dialect with no applicator list is refused', () => {
    const applicators = JSON.parse(readFileSync(join(REPO, 'model', 'applicators.json'), 'utf8'))
    delete applicators.dialects['wright-00']
    assert.throws(() => Gen.generate({ applicators }), /no applicator list for dialect wright-00/)
  })
})
