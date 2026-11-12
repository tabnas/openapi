// The minimal reproductions from the corpus sweep, each run through
// @tabnas/openapi's parse and the yaml reference (YAML 1.2 core schema).
// Prints PASS when the trees agree (or, for the reference-artifact row,
// when tabnas matches the value the YAML spec and PyYAML give).
const O = require(process.env.OPENAPI_DIST || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const Y = require(process.env.YAML_REF || 'yaml')
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
  let t, r
  try { t = JSON.stringify(O.parse(text)) } catch (e) { t = 'ERR ' + e.code }
  r = JSON.stringify(Y.parse(text, { version: '1.2', schema: 'core' }))
  const ok = t === r
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n     text   ${JSON.stringify(text)}\n     tabnas ${t}\n     yaml   ${r}`)
}
// L: the yaml reference is wrong here (YAML 1.2.2 8.1.1.1; PyYAML agrees with tabnas)
{ const t = JSON.stringify(O.parse('a: |2-\n      x\n     \nb: 1\n')); const want = JSON.stringify({ a: '    x\n   ', b: 1 }); console.log(`${t === want ? 'PASS' : 'FAIL'} L  |2- trailing space line (reference-parser artifact)\n     tabnas ${t}\n     want   ${want}`); if (t !== want) fail++ }
console.log(`repros: ${cases.length + 1 - fail} of ${cases.length + 1} pass`)
