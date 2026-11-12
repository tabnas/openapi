#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/corpus/probe.cjs: YAML features the corpus barely uses, probed
// with small synthetic texts against the reference parser (core schema,
// merge keys on). Prints `same` or `DIFF` per probe, with both readings
// where they differ. A record, not a gate: it exits 0 either way.
//
//   node tools/corpus/probe.cjs

const E = require('./examine.cjs')
const { O, YAML } = E.load()

const cases = {
  anchorAlias: 'a: &x {b: 1}\nc: *x\n',
  anchorBlock: 'a: &x\n  b: 1\nc: *x\n',
  merge: 'a: &x\n  b: 1\nc:\n  <<: *x\n  d: 2\n',
  mergeList: 'a: &x {b: 1}\ne: &y {f: 2}\nc:\n  <<: [*x, *y]\n',
  mergeOverride: 'a: &x {b: 1, d: 0}\nc:\n  <<: *x\n  d: 2\n',
  tagStr: 'a: !!str 123\n',
  tagCustom: 'a: !foo bar\n',
  tagBinary: 'a: !!binary aGVsbG8=\n',
  literal: 'a: |\n  x\n  y\n',
  literalStrip: 'a: |-\n  x\n\n',
  literalKeep: 'a: |+\n  x\n\n',
  folded: 'a: >\n  x\n  y\n\n  z\n',
  foldedMoreIndented: 'a: >\n  x\n    y\n  z\n',
  indentIndicator: 'a: |2\n    x\n  y\n',
  plainMultiline: 'a: x\n  y\n  z\n',
  dqMultiline: 'a: "x\n  y"\n',
  sqEscape: "a: 'it''s'\n",
  dqEscapes: 'a: "\\u00e9\\t\\x41\\/\\N"\n',
  crlf: 'a: 1\r\nb: x\r\n',
  bom: '\ufeffa: 1\n',
  docStart: '---\na: 1\n',
  docEnd: 'a: 1\n...\n',
  directive: '%YAML 1.2\n---\na: 1\n',
  commentAfterKey: 'a: # c\n  b: 1\n',
  tabsAfterColon: 'a:\t1\n',
  flowMultiline: 'a: {b: 1,\n  c: 2}\n',
  flowSeqMultiline: 'a: [1,\n  2,\n  3]\n',
  explicitKey: '? a\n: 1\n',
  seqOfMaps: 'a:\n- b: 1\n  c: 2\n- d: 3\n',
  seqIndented: 'a:\n  - b: 1\n    c: 2\n',
  emptyValue: 'a:\nb: 1\n',
  colonInValue: 'a: http://x.y/z\n',
  hashInValue: 'a: x#y\n',
  quotedKey: '"a b": 1\n',
  longKeyColon: 'a:b: 1\n',
  nestedSeq: 'a:\n- - 1\n  - 2\n',
  nullValues: 'a: null\nb: ~\nc:\n',
  dateValue: 'a: 2001-12-14t21:59:43.10-05:00\n',
  unicodeKey: 'é: 1\n',
  emptyFlow: 'a: {}\nb: []\n',
  dupKey: 'a: 1\na: 2\n',
  dupMap: 'a: {b: 1}\na: {c: 2}\n',
  indentedRoot: '  a: 1\n  b: 2\n',
  commentOnly: '# x\na: 1\n# y\n',
  plainWithColonSpace: 'a: b: c\n',
  jsonInYaml: '{"a": 1, "b": [true, null]}\n',
  jsonLikeWithComment: '{"a": 1} # c\n',
  multilineFlowKey: 'a: [\n  {b: 1},\n  {c: 2}\n]\n',
  aliasAsKey: 'a: &k x\n*k : 1\n',
  blockScalarInSeq: 'a:\n  - |\n    x\n  - y\n',
  trailingSpaces: 'a: x   \nb: 1\n',
  questionPlain: 'a: ?x\n',
  dashPlain: 'a: -x\n',
  star: 'a: "*"\n',
  percentPlain: 'a: 50%\n',
  atStart: 'a: "@x"\n',
  backtick: 'a: `x`\n',
}
for (const [n, s] of Object.entries(cases)) {
  let r, t
  try { const d = YAML.parseDocument(s, { schema: 'core', merge: true, uniqueKeys: false }); r = d.errors.length ? 'YAMLERR ' + d.errors[0].code : JSON.stringify(d.toJS()) } catch { r = 'YAMLTHROW' }
  try { t = JSON.stringify(O.parse(s)) } catch (e) { t = 'ERR ' + e.code }
  console.log((r === t ? 'same ' : 'DIFF ') + n.padEnd(20) + ' tabnas ' + t + (r === t ? '' : '   yaml ' + r))
}
