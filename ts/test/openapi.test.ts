/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The plugin installs on jsonic with the yaml grammar, or with `strict`
// on the json grammar alone, and changes nothing yet: the Petstore
// description parses to the tree jsonic and yaml give without it, from
// its YAML form and its JSON form alike, and the JSON form to what
// JSON.parse gives. The JSON copy in test/petstore was written from the
// YAML by an independent reader, so the two agreeing is a check of the
// parse rather than of a copy made by it.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { Yaml } from '@tabnas/yaml'

import { OpenApi, make, VERSION } from '..'

const PETSTORE = join(__dirname, '..', '..', 'test', 'petstore')
const read = (name: string) => readFileSync(join(PETSTORE, name), 'utf8')

// The engine builds null-prototype containers; a JSON round trip compares
// the value and not the prototype.
const C = (x: any) => JSON.parse(JSON.stringify(x))

describe('openapi', () => {
  test('exports the plugin, make and VERSION', () => {
    assert.equal('function', typeof OpenApi)
    assert.equal('function', typeof make)
    assert.match(VERSION, /^\d+\.\d+\.\d+/)
  })

  test('the YAML description parses as jsonic and yaml alone parse it', () => {
    const yaml = read('petstore.yaml')
    const base = new Tabnas().use(jsonic).use(Yaml)
    assert.deepEqual(C(make().parse(yaml)), C(base.parse(yaml)))
  })

  test('the YAML and JSON forms parse to one document', () => {
    const want = JSON.parse(read('petstore.json'))
    assert.deepEqual(C(make().parse(read('petstore.yaml'))), want)
    assert.deepEqual(C(make().parse(read('petstore.json'))), want)
  })

  test('strict reads the JSON form and refuses the YAML form', () => {
    const strict = make({ strict: true })
    assert.deepEqual(C(strict.parse(read('petstore.json'))), JSON.parse(read('petstore.json')))
    assert.throws(() => strict.parse(read('petstore.yaml')))
  })

  test('the plugin installs by hand on jsonic with the yaml grammar', () => {
    const tn = new Tabnas().use(jsonic).use(Yaml).use(OpenApi)
    assert.deepEqual(C(tn.parse('paths:\n  /pets: {}')), { paths: { '/pets': {} } })
  })
})
