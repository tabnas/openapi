/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: this checkout's package with the prototype's `resolve` in place of
// its own, so that a tool that takes the package by OPENAPI_DIST can be
// run on the prototype:
//
//   OPENAPI_DIST=$PWD/docs/design/prototype/e12-site-index/as-package.cjs \
//   EXPR_DIST=<expr build with site.written>/ts/dist/expr.js \
//   node tools/apidef-preset.cjs ../apidef --ref 3b24341 --corpus .corpus/src \
//     --rows test/resolve/apidef.tsv test/resolve/apidef-extra.tsv

const Path = require('node:path')

const O = require(Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const R = require('./resolver.cjs')

module.exports = { ...O, resolve: R.resolve, ResolveError: R.ResolveError }
