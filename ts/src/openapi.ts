/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// @tabnas/openapi: OpenAPI and Swagger documents, in JSON or YAML, for the
// tabnas engine.
//
// The plugin installs on a jsonic instance that carries the yaml grammar,
// so one parser reads both serialisations, or, with `strict`, on the
// strict json grammar alone. Raw mode, the document exactly as written, is
// the engine's own parse; the checks the engine cannot make (the root, a
// stream of several documents, the version) come with the `parse` wrapper
// of raw mode, and resolution, a derived tree with `$ref` resolved, is an
// OpenAPI vocabulary over @tabnas/expr's fold. The plan is
// docs/design/implementation-plan.md.

import { Tabnas, Plugin } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { Yaml } from '@tabnas/yaml'
import { json } from '@tabnas/json'

// Plugin options. There are none yet: raw mode needs none, and the
// resolver's options belong to `resolve`, since `use()` deep-copies what
// it is given.
type OpenApiOptions = Record<string, never>

// The plugin. It installs after the base grammar and records nothing on
// the parsed tree.
const OpenApi: Plugin = function OpenApi(_tn: Tabnas, _options: OpenApiOptions) {
  // Installs, and changes nothing yet.
}

OpenApi.defaults = {} as OpenApiOptions

// Options for `make`.
type MakeOptions = {
  // Read strict JSON (RFC 8259) with the json grammar alone, instead of
  // JSON and YAML with jsonic and the yaml grammar.
  strict?: boolean
}

// A parser instance with the plugin installed: jsonic with the yaml
// grammar, which reads JSON text as the strict json grammar does and YAML
// besides, or, with `strict`, json alone.
function make(options: MakeOptions = {}): Tabnas {
  const tn = true === options.strict
    ? new Tabnas().use(json)
    : new Tabnas().use(jsonic).use(Yaml)
  return tn.use(OpenApi)
}

// VERSION is this package's version. It MUST equal package.json "version":
// the release orchestrator rewrites both, and the version test fails the
// build if they drift. Mirrors `const VERSION` in go/openapi.go and
// `VERSION` in rs/src/lib.rs.
const VERSION = '0.1.0'

export { OpenApi, make, VERSION }

export type { OpenApiOptions, MakeOptions }
