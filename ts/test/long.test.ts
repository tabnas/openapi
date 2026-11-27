/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The fixtures of test/long/: texts too long to write out as a row,
// each built from parts.
//
// A file is a note and its cases. A case has `text`, a list of parts:
// a string, or a map of `repeat`, `of` and an optional `join`, which is
// `of` written `repeat` times with `join` between. In `of`, `{i}` is the
// count from 0, `{j}` the count from 1, and `{s}` as many spaces as the
// count from 0. `bytes` is the size of the built text as UTF-8, which
// holds a builder to the recipe. A case of `parse.json` gives its
// options to `parse`, and one of `resolve.json` gives them to `resolve`
// once `parse` has read the text. A case of `resolve.json` may have
// `documents`, the description's other documents by URI: each is a text
// built from parts in the same way, and is given to `resolve` as text,
// and `bytes` then counts them too. A case says `error`, the code it is
// refused with, or `reads`: a path into the tree, how many items the
// list there has, or how many members the map, and where it is given
// `last`, the last of them.
//
// These are the shapes that ts/test/hostile.test.ts holds to a time,
// which no fixture can carry. What a case carries is that the shape is
// refused, or read. See ../../test/AGENTS.md.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse, resolve } from '../dist/openapi'

// At runtime this file is in ts/dist-test, so the repository root is two up.
const DIR = join(__dirname, '..', '..', 'test', 'long')

type Part = string | { repeat: number; of: string; join?: string }
type Case = {
  note: string
  text: Part[]
  documents?: Record<string, Part[]>
  options?: Record<string, unknown>
  error?: string
  reads?: { at: (string | number)[]; length: number; last?: unknown }
  bytes: number
}

// The text of a case.
function build(parts: Part[]): string {
  let out = ''
  for (const part of parts) {
    if ('string' === typeof part) {
      out += part
      continue
    }
    const items: string[] = []
    for (let i = 0; i < part.repeat; i++) {
      items.push(part.of.replaceAll('{i}', String(i)).replaceAll('{j}', String(i + 1)).replaceAll('{s}', ' '.repeat(i)))
    }
    out += items.join(part.join ?? '')
  }
  return out
}

// What reads each file's texts.
const READERS: Record<string, (text: string, options: Record<string, unknown>) => unknown> = {
  'parse.json': (text, options) => parse(text, options),
  'resolve.json': (text, options) => resolve(parse(text), options).tree,
}

describe('long texts, from test/long', () => {
  test('the folder holds the files this runner reads, and nothing else', () => {
    assert.deepEqual(readdirSync(DIR).sort(), Object.keys(READERS).sort())
  })

  for (const [file, read] of Object.entries(READERS)) {
    const cases: Case[] = JSON.parse(readFileSync(join(DIR, file), 'utf8')).cases

    test(`${file} has cases, each with one expectation`, () => {
      assert.ok(0 < cases.length, file + ' has no case')
      for (const c of cases) assert.ok((undefined === c.error) !== (undefined === c.reads), c.note)
    })

    for (const [n, c] of cases.entries()) {
      test(`${file}, case ${n + 1}: ${c.note.slice(0, 70)}`, () => {
        const text = build(c.text)
        const documents: Record<string, string> = {}
        for (const [uri, parts] of Object.entries(c.documents ?? {})) documents[uri] = build(parts)
        const size = Object.values(documents).reduce((sum, d) => sum + Buffer.byteLength(d), Buffer.byteLength(text))
        assert.equal(size, c.bytes, 'the size of the built text')
        const options = undefined === c.documents ? c.options ?? {} : { ...(c.options ?? {}), documents }
        if (undefined !== c.error) {
          assert.throws(
            () => read(text, options),
            (e: any) => c.error === e.code,
            `should be refused with ${c.error}`,
          )
          return
        }
        let value: any = read(text, options)
        for (const key of c.reads!.at) value = value[key]
        const items: unknown[] = Array.isArray(value) ? value : Object.values(value)
        assert.equal(items.length, c.reads!.length)
        if ('last' in c.reads!) {
          assert.deepStrictEqual(JSON.parse(JSON.stringify(items[items.length - 1] ?? null)), c.reads!.last, 'the last of them')
        }
      })
    }
  }
})
