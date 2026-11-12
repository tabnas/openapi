// apidef's own reader, at the versions an apidef checkout has installed:
// Jsonic with the Yaml plugin, as apidef's ts/src/parse.ts builds it. Given
// to the E7 sweep in place of this package, it shows what apidef itself
// reads from each document:
//
//   OPENAPI_DIST=$PWD/apidef-reader.cjs APIDEF_TS=<apidef>/ts \
//     node ../e7-corpus/driver.cjs <manifest.jsonl> <results.jsonl>
//
// APIDEF_TS: the ts/ folder of an apidef checkout with its dependencies installed.
const Path = require('node:path')
const AP = process.env.APIDEF_TS
if (!AP) throw new Error('set APIDEF_TS to the ts/ folder of an apidef checkout with its dependencies installed')
const { Jsonic } = require(AP + '/node_modules/@tabnas/jsonic')
const { Yaml } = require(AP + '/node_modules/@tabnas/yaml')
const real = require(process.env.OPENAPI_REAL || Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist', 'openapi.js'))
const yamlParser = Jsonic.make().use(Yaml)
module.exports = { parse: (text) => yamlParser(text), version: real.version, resolve: real.resolve }
