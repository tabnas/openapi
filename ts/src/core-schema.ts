/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// What `make` asks of the yaml grammar before it calls a parser the
// specification's reading.

// The least this check needs of a parser.
type Reads = { parse: (text: string) => unknown }

// Whether the yaml grammar on a parser reads a plain scalar as the YAML
// 1.2 core schema does. It is asked with the shortest text the two
// schemas part on: `yes` is a string to the core schema, and true to the
// grammar's own reading, which follows YAML 1.1 there.
//
// `make` passes the grammar `schema: 'core'` under `reading: 'spec'`.
// The option arrived in @tabnas/yaml 0.5.33, and a grammar before it
// takes an option it does not know in silence. This package names no
// version of that one, so the parser itself is asked, once for each
// parser `make` builds.
function readsCoreSchema(tn: Reads): boolean {
  return 'yes' === tn.parse('yes')
}

export { readsCoreSchema }
