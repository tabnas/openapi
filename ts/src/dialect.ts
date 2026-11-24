/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// JSON Schema dialects, as far as resolving references needs them: what
// names a schema resource and an anchor, whether the members beside a
// `$ref` are read, and which keyword is a reference whose target depends
// on the schemas being evaluated. Which members of a schema hold schemas
// is the object model's, in model/applicators.json.
//
// A Schema Object of OpenAPI 3.1 or 3.2 says which dialect it is written
// in with `$schema`, and the description says which its schemas are in
// unless they say, with `jsonSchemaDialect`. This package reads five:
// draft-04, draft-06, draft-07, 2019-09 and 2020-12, which is also what
// the OpenAPI dialects of 3.1 and 3.2 are read by. Any other is read as
// 2020-12, and reported.

import { normalizeUri } from './uri'

type DialectName = 'draft-04' | 'draft-06' | 'draft-07' | '2019-09' | '2020-12'

type Dialect = {
  name: DialectName
  // The member that names a schema resource. Its URI is the base of the
  // references in and below the schema.
  id: 'id' | '$id'
  // Whether that member, when it is a fragment alone (`#name`), names an
  // anchor and leaves the base as it was.
  idAnchor: boolean
  // The members that name an anchor.
  anchors: readonly string[]
  // Whether a `$ref` stands alone: the members beside it are not read, an
  // identifier among them included.
  refAlone: boolean
  // The reference whose target depends on the schemas being evaluated,
  // which is reported and never followed.
  dynamic: '$recursiveRef' | '$dynamicRef' | null
}

const DIALECTS: Record<DialectName, Dialect> = {
  'draft-04': { name: 'draft-04', id: 'id', idAnchor: true, anchors: [], refAlone: true, dynamic: null },
  'draft-06': { name: 'draft-06', id: '$id', idAnchor: true, anchors: [], refAlone: true, dynamic: null },
  'draft-07': { name: 'draft-07', id: '$id', idAnchor: true, anchors: [], refAlone: true, dynamic: null },
  '2019-09': {
    name: '2019-09',
    id: '$id',
    idAnchor: false,
    anchors: ['$anchor'],
    refAlone: false,
    dynamic: '$recursiveRef',
  },
  '2020-12': {
    name: '2020-12',
    id: '$id',
    idAnchor: false,
    anchors: ['$anchor', '$dynamicAnchor'],
    refAlone: false,
    dynamic: '$dynamicRef',
  },
}

// The identifiers of the dialects this package knows, in their normal
// form and without the empty fragment the older ones are written with.
// json-schema.org serves each under `http` and under `https`, and each
// draft has a hyper-schema dialect that reads references as it does.
const DRAFT = /^https?:\/\/json-schema\.org\/draft-0([467])\/(?:hyper-)?schema$/
const DATED = /^https?:\/\/json-schema\.org\/draft\/(2019-09|2020-12)\/(?:hyper-)?schema$/
const OPENAPI = /^https?:\/\/spec\.openapis\.org\/oas\/3\.[12]\/dialect\/[^/?#]+$/

// The dialect a `$schema` or `jsonSchemaDialect` value names, and whether
// this package knows it. One it does not know is read as 2020-12.
function dialectOf(uri: string): { dialect: Dialect; known: boolean } {
  const id = normalizeUri(uri).replace(/#$/, '')
  let m = DRAFT.exec(id)
  if (null !== m) return { dialect: DIALECTS[('draft-0' + m[1]) as DialectName], known: true }
  m = DATED.exec(id)
  if (null !== m) return { dialect: DIALECTS[m[1] as DialectName], known: true }
  return { dialect: DIALECTS['2020-12'], known: OPENAPI.test(id) }
}

// A dialect a description declares, and the one it is read by: `at` is
// the member that declares it, the root's `jsonSchemaDialect` or a
// schema's `$schema`; `dialect` is its value as written; `as` is the
// dialect whose rules it is read by; and `known` is false for one this
// package does not know, which is read as 2020-12.
type DialectUse = { at: string; dialect: string; as: DialectName; known: boolean; doc?: string }

export { DIALECTS, dialectOf }

export type { Dialect, DialectName, DialectUse }
