// Which of the reading differences the corpus sweep found can this package
// switch off by itself, with options on the parser `make` builds and no
// change to a base grammar?
//
// usage: node reading-options.cjs
const Path = require('node:path')
const { make, parse } = require(process.env.OPENAPI_DIST || Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const J = JSON.stringify
const cases = [
  'a: //api.example.com/', 'a: /* x */', 'a: /*', 'a:\n  //x:\n    b: 1',
  'a: 1_000', 'a: 01009_01', 'a: 0b11', 'a: 0x1F', 'a: 0o17',
  'a: [on, NO, yes]', 'a: 1 # a YAML comment', '# a YAML comment\na: 1',
]
const run = (label, tn) => {
  console.log('== ' + label)
  for (const c of cases) {
    let out
    try { out = J(parse('openapi: 3.0.0\n' + c + '\n', { instance: tn }).a) } catch (e) { out = 'ERROR ' + e.code }
    console.log('  ' + J(c).padEnd(34), out)
  }
}
run('as shipped', make())
const tn = make()
tn.options({ comment: { def: { slash: { lex: false }, multi: { lex: false } } }, number: { sep: null } })
run('comment.def.slash and comment.def.multi off, number.sep unset', tn)
