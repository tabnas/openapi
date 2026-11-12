// This package with the two engine options that end jsonic's comment syntax
// and `_` in numbers, set on the parser `make` builds. Given to the E7 sweep
// in place of the package as shipped, it shows what those options repair:
//
//   OPENAPI_DIST=$PWD/with-options.cjs node ../e7-corpus/driver.cjs <manifest.jsonl> <results.jsonl>
const Path = require('node:path')
const real = require(process.env.OPENAPI_REAL || Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const tn = real.make()
tn.options({ comment: { def: { slash: { lex: false }, multi: { lex: false } } }, number: { sep: null } })
module.exports = { parse: (text, opts) => real.parse(text, { ...(opts || {}), instance: tn }), version: real.version, resolve: real.resolve }
