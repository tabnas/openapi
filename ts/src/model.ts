/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The OpenAPI object model: what a position in a description holds, for
// each version this package reads. The table is generated from the OpenAPI
// Initiative's validation schemas by tools/object-model.cjs (see
// object-model.ts); this file only walks it.
//
// A position's state is named by a string. A state is one of:
//
//   object      an OpenAPI object of a named type, or an anonymous map,
//               whose members are found by name, then by pattern, then
//               by a catch-all;
//   list        a list, whose items share one state;
//   refable     a slot that holds either a Reference Object or an object
//               of the named type (its target), as `response?`;
//   schema      a Schema Object, whose members the dialect's applicator
//               list types;
//   data        plain JSON, never a site;
//   locator     a URI reference that is resolved and checked, never
//               substituted (a Link's operationRef);
//   connection  a name that names something elsewhere (a tag, an
//               operationId, a security scheme);
//   mapping     a Discriminator mapping value, a schema name or a URI.
//
// An unknown position is data.

import { OBJECT_MODEL } from './object-model'

// The versions the model covers.
type ModelVersion = '2.0' | '3.0' | '3.1' | '3.2'

type SlotKind =
  | 'object'
  | 'list'
  | 'refable'
  | 'schema'
  | 'data'
  | 'locator'
  | 'connection'
  | 'mapping'

// A position, as the model sees it.
type Slot = {
  // The state's name in the table, which `step` takes.
  state: string
  kind: SlotKind
  // The object type: `response`, `pathItem`, `schema`; for a refable slot,
  // the type it holds when it holds no Reference Object; for a locator or
  // connection, what it names. Null for an anonymous map or list.
  type: string | null
  // For a refable slot, the state of the object it holds.
  target?: string
  // For a Schema Object, its dialect.
  dialect?: string
  // What the member names of a map name, when they name something: a
  // Security Requirement's names name security schemes.
  keys?: string
}

type State = {
  kind: SlotKind
  type?: string | null
  props?: Record<string, string>
  patterns?: [string, string][]
  rest?: string
  items?: string
  target?: string
  dialect?: string
  keys?: string
}

const VERSIONS = Object.keys(OBJECT_MODEL.versions) as ModelVersion[]

function table(version: ModelVersion): Record<string, State> {
  const v = (OBJECT_MODEL.versions as any)[version]
  if (null == v) {
    throw new Error('model: no object model for version ' + JSON.stringify(version))
  }
  return v.states
}

// Compiled member-name patterns, shared by every version.
const PATTERNS = new Map<string, RegExp>()

function pattern(src: string): RegExp {
  let re = PATTERNS.get(src)
  if (null == re) {
    re = new RegExp(src, 'u')
    PATTERNS.set(src, re)
  }
  return re
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

// The state of the root of a description.
function rootState(): string {
  return 'root'
}

// The state of a member of a position: by name, then by the first pattern
// that matches, then the catch-all; an index of a list is its item state.
// A refable slot steps as the object it holds, so a member of a Reference
// Object ($ref, summary, description) reads as the target's member of that
// name, which is data where the target has none.
function step(version: ModelVersion, state: string, member: string | number): string {
  const states = table(version)
  let s = states[state]
  if (null == s) return 'data'
  if ('refable' === s.kind && null != s.target) {
    s = states[s.target]
    if (null == s) return 'data'
  }
  const index = 'number' === typeof member || /^(?:0|[1-9][0-9]*)$/.test(member)
  if ('list' === s.kind) {
    return index && null != s.items ? s.items : 'data'
  }
  if ('object' !== s.kind && 'schema' !== s.kind) return 'data'
  if (index && null != s.items) return s.items
  const name = String(member)
  if (null != s.props && own(s.props, name)) return s.props[name]
  for (const [src, to] of s.patterns ?? []) {
    if (pattern(src).test(name)) return to
  }
  return s.rest ?? 'data'
}

// What a state is.
function slot(version: ModelVersion, state: string): Slot {
  const s = table(version)[state]
  if (null == s) return { state: 'data', kind: 'data', type: null }
  const out: Slot = { state, kind: s.kind, type: s.type ?? null }
  if (null != s.target) out.target = s.target
  if (null != s.dialect) out.dialect = s.dialect
  if (null != s.keys) out.keys = s.keys
  return out
}

// What the position at `path` in a description of `version` holds.
function classify(version: ModelVersion, path: readonly (string | number)[]): Slot {
  let state = rootState()
  for (const member of path) {
    state = step(version, state, member)
    if ('data' === state) break
  }
  return slot(version, state)
}

export { VERSIONS as MODEL_VERSIONS, classify, rootState, slot, step }

export type { ModelVersion, Slot, SlotKind }
