#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/repros.cjs: the smallest texts that show each class the
// sweep found, read by the package and by the reference parser.
//
// Each case was cut from a corpus document with minimize.cjs. It prints
// PASS where the two trees agree, FAIL where they do not, and how many
// pass. Row L guards the reference parser's own error: the package is
// right there, by YAML 1.2.2 section 8.1.1.1, and the row passes when the
// package keeps that reading. A FAIL is not a test failure: the command
// exits 0 either way, and the count says how many classes are still open.
//
//   node tools/corpus/repros.cjs

const E = require('./examine.cjs')
const { O, YAML } = E.load()

const cases = [
  ['A1 /* opens a comment in a plain scalar', 'a: /*\n'],
  ['A2 // opens a comment: value lost as null', 'a: //api.example.com/\n'],
  ['A2b /* ... */ value lost as null', 'a: /* x */\n'],
  ['A3 //key: line read as a comment', 'a:\n  //x:\n    b: 1\n'],
  ['B  indented root mapping', '  a: 1\n  b: 2\n'],
  ['B2 indented root after ---', '---\n  a: 1\n  b: 2\n'],
  ['C  digit-led key with colons, block value', 'a:\n  1:2:\n    b: 1\n'],
  ['D  .digit then text', 'a: .5 x\n'],
  ['E  YAML 1.1 boolean words', 'a: [on, off, yes, no, On, OFF]\n'],
  ['F  underscore digit separator', 'a: 1_000\n'],
  ['F2 binary, Infinity, signed hex', 'a: [0b11, Infinity, -0x1F]\n'],
  ['H  compact nested sequences', 'a:\n- - x\n- - y\n'],
  ['I1 empty item in zero-indented sequence', 'a:\n- x\n-\n- y\n'],
  ['I2 empty value ends a map in zero-indented sequence', 'a:\n- b: 1\n  v:\n- c: 2\n'],
  ['J  scalar on the line after its key', 'a:\n  1\nb:\n  true\nc:\n  null\n'],
  ['K  >+ with a trailing space-only line', 'a: >+\n  x\n   \nb: 1\n'],
]
let fail = 0
for (const [name, text] of cases) {
  let t
  try { t = JSON.stringify(O.parse(text)) } catch (e) { t = 'ERR ' + e.code }
  const r = JSON.stringify(YAML.parse(text, { version: '1.2', schema: 'core' }))
  const ok = t === r
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n     text   ${JSON.stringify(text)}\n     tabnas ${t}\n     yaml   ${r}`)
}
{
  const t = JSON.stringify(O.parse('a: |2-\n      x\n     \nb: 1\n'))
  const want = JSON.stringify({ a: '    x\n   ', b: 1 })
  if (t !== want) fail++
  console.log(`${t === want ? 'PASS' : 'FAIL'} L  |2- trailing space line (the reference parser's error)\n     tabnas ${t}\n     want   ${want}`)
}
console.log(`repros: ${cases.length + 1 - fail} of ${cases.length + 1} pass`)
