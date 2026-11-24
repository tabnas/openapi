/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The connections report: every place a description names something
// other than through `$ref`, and whether what it names is there. A Link
// names an operation by operationId, or locates one with operationRef; a
// Security Requirement's member names name security schemes; an
// operation's tags name tags; a 3.2 tag names its parent; a Discriminator
// maps payload values to schemas by name or URI, and by the names of the
// schemas it is beside or that build on its own; a `$dynamicRef` or a
// `$recursiveRef` has an initial target; a server's URL names its
// variables. Nothing here is substituted into the tree: the report says
// what each name reaches, and the caller decides. The URLs a description
// gives for things outside it are a report of their own, since nothing
// here can say whether one is there.
//
// A template is read where it is written, too: a path, or a server's
// URL, whose braces are no template's is said, with one that names a
// thing twice, a path with no leading slash, a server's URL with a query
// or a fragment, and two paths that are one template under other names.
// What a name of a path or of a runtime expression reaches depends on
// the operation, and is read on the routes, in operations.ts.
//
// Everything here is read from the site index (site-index.ts), which has
// the type of every location, the base URI it is read under, and where a
// path lands. So a name inside example data is data; a name in a region
// that only a reference types is found; and whether a target is there is
// judged on the document as written, with a step that is missing at a
// reference read in what that reference names. None of it depends on the
// shape the caller asked the resolved tree in.

import { ExpressionError, namesOf, readTemplate } from './expression'
import type { TemplatePart } from './expression'
import { slot, step } from './model'
import type { ModelVersion } from './model'
import { EXTRA_FACTOR, hasIds as schemasHaveIds } from './site-index'
import type { DocFacts, Landing, Loc, SiteIndex } from './site-index'
import { ANCHOR, NOTHING, fragmentOf, hierarchical, isMap, normalizeUri, own, pointer, resolveUri, stepInto } from './uri'
import type { Path } from './uri'

type ConnectionKind =
  | 'operationId'
  | 'operationRef'
  | 'securityScheme'
  | 'tag'
  | 'tagParent'
  | 'mapping'
  | 'defaultMapping'
  | 'implicitMapping'
  | 'dynamicRef'
  | 'recursiveRef'
  | 'pathItemMerge'
  | 'operationIdReuse'
  | 'serverVariable'
  | 'template'
  | 'pathClash'
  | 'pathParameter'
  | 'expression'
  | 'linkParameter'

// One connection: the position that names something (`at`), the name or
// URI as written, whether its target is there, and where. The other
// members appear only for the kinds they belong to.
type Connection = {
  kind: ConnectionKind
  at: string
  // The document that position is in, by the URI it was given under,
  // where it is not the description.
  doc?: string
  name: string
  found: boolean
  target: string | null
  // The document `target` is in, by the URI it was given under, where
  // that is not the description.
  targetDoc?: string
  // Why a URI found nothing: as the resolver's unresolved reasons. For a
  // `template`, what is wrong with it: `malformed` braces, a name
  // `repeated`, `no-slash` at the start of a path, a `query` or a
  // `fragment` in a server's URL. For a `pathParameter` not found, which
  // side is missing: `no-parameter` for an expression of the path, and
  // `no-expression` for a path parameter. For an `expression`,
  // `malformed` where a callback's key is no runtime expression. For a
  // name of a parameter that is not found, `unresolved` where the
  // operation has a parameter by a reference that is left as written,
  // which may be the one.
  why?: string
  // The object-model type at a located target: operationRef must reach
  // an `operation`, a security requirement URI a `securityScheme`.
  type?: string | null
  // How a security requirement key or a mapping value was read.
  via?: 'name' | 'uri'
  // A 3.2 security requirement key that is a security scheme's name and
  // also locates one as a URI; the name wins. And a Link's parameter name
  // that parameters of the operation have in more than one location.
  ambiguous?: boolean
  // Every operation that declares an operationId a Link names, when more
  // than one does.
  targets?: string[]
  // A 3.2 tag whose chain of parents loops.
  cycle?: boolean
  // A `$dynamicRef` whose initial target has a `$dynamicAnchor` of the
  // fragment's name, or a `$recursiveRef` whose initial target has
  // `$recursiveAnchor: true`.
  anchor?: boolean
  // A Path Item `$ref`'s fields that are also in the Path Item it names,
  // where the specification leaves the merge undefined.
  fields?: string[]
  // Every route through paths, webhooks and callbacks that reaches an
  // operation with one operationId, when there is more than one. For a
  // `pathClash`, every path that is the one template.
  routes?: string[]
  // Where an implicit mapping comes from: a schema listed beside the
  // discriminator in `oneOf` or `anyOf`, one that builds on the
  // discriminator's schema with `allOf`, or in 2.0 that schema itself.
  from?: 'oneOf' | 'anyOf' | 'allOf' | 'self'
}

// A URL or URI that a description gives for something outside it: its
// terms of service, an external example, a server, a token endpoint.
// `value` is the field as written. `base` is what a relative value is
// relative to: the description's base URI where the field is
// (`description`), the URI the description was retrieved from
// (`retrieval`, for a Server Object's `url`), a server of the API (`api`),
// or nothing, where the value must be absolute (`none`). `uri` is the
// absolute URI in its normal form, where the value has one that this
// package can work out. A value written with a scheme always has one,
// but for a server's URL with variables. A relative one has one under
// `description` and `retrieval`, where its base is a URI that a relative
// reference can be read against: the base a description has when nobody
// says where it is stands for no location, and gives none. Nothing is
// loaded.
type UrlUse = {
  at: string
  // The document the field is in, where it is not the description.
  doc?: string
  value: string
  base: 'description' | 'retrieval' | 'api' | 'none'
  uri?: string
}

// The operations that declare each operationId, the description's
// first, each with its location.
type Declared = Map<string, { doc: DocFacts; at: string; loc: Loc | undefined }[]>

type Use = {
  kind: ConnectionKind
  // Its place in the walk.
  order: number
  // The document the use is in.
  doc: DocFacts
  at: string
  name: string
  base: string
  holder?: string
  // For an implicit mapping: the schema that has the discriminator.
  loc?: Loc
  node?: any
}

// A URI with a scheme, which needs no base.
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/

// The absolute form of a URL as written, in its normal form: its own
// where it has a scheme, and else its form against `base`, where there
// is one and a relative reference can be read against it.
const absoluteOf = (value: string, base: string | undefined): string | undefined =>
  ABSOLUTE.test(value)
    ? normalizeUri(resolveUri('', value))
    : undefined !== base && hierarchical(base)
      ? normalizeUri(resolveUri(base, value))
      : undefined

const esc = (seg: string | number) => String(seg).replace(/~/g, '~0').replace(/\//g, '~1')

// The value at a path in a tree, or NOTHING.
function reach(root: any, path: Path): any {
  let node = root
  for (const seg of path) {
    node = stepInto(node, seg)
    if (NOTHING === node) return NOTHING
  }
  return node
}

// The members of the map at `path` in the raw tree, by name, or none.
function namesAt(raw: any, path: Path): Record<string, any> {
  const node = reach(raw, path)
  return isMap(node) ? node : Object.create(null)
}

function connectionsOf(
  raw: any,
  mv: ModelVersion,
  index: SiteIndex,
  hasIds: boolean,
  tick?: () => void,
): { rows: Connection[]; urls: UrlUse[]; declared: Declared } {
  // The operations that declare each operationId, in every document.
  const declared: Declared = new Map()
  // A root that is neither a map nor a list names nothing.
  if (!Array.isArray(raw) && !isMap(raw)) return { rows: [], urls: [], declared }
  const home = index.docs[0]
  const uses: Use[] = []
  const urls: UrlUse[] = []
  // What is read where it is written: a server's variables, and the
  // templates that are not well made. Each with its place in the walk.
  const written: [number, Connection][] = []
  let order = 0
  const use = (u: Omit<Use, 'order'>) => uses.push({ ...u, order })
  // The tags of the description. A name used in another document is
  // looked for among these, as the specification recommends.
  const tags = new Map<string, { at: string; parent?: string }>()

  // Every position the index types, in document order, a container before
  // its members. A value that is neither a map nor a list has no location
  // of its own: its state is its parent's step to it, and it is read under
  // its parent's base URI.
  //
  // Every document of the set is walked, each by the model of its own
  // version. One that declares no version is data at its root, and is
  // walked where a reference has typed it.
  type Frame = { node: any; loc: Loc | undefined; at: string; state: string; base: string; last: string | number; depth: number; holder: any }
  for (const doc of index.docs) {
  if (!Array.isArray(doc.raw) && !isMap(doc.raw)) continue
  const dmv = doc.mv
  const ids = doc === home ? hasIds : schemasHaveIds(dmv)
  const stack: Frame[] = [{ node: doc.raw, loc: doc.root, at: '', state: doc.root.state, base: '', last: '', depth: 0, holder: undefined }]
  while (0 < stack.length) {
    const f = stack.pop()!
    if (undefined !== tick) tick()
    const node = f.node
    const loc = f.loc
    const state = undefined !== loc ? loc.state : f.state
    if ('data' !== state) {
      const s = slot(dmv, state)
      // The reference a schema's dialect leaves to evaluation: 2020-12's
      // `$dynamicRef`, or 2019-09's `$recursiveRef`.
      const dynamic = ids && 'schema' === s.kind && isMap(node) ? loc?.rules?.dynamic : undefined
      if (null != dynamic && 'string' === typeof node[dynamic]) {
        use({
          kind: '$dynamicRef' === dynamic ? 'dynamicRef' : 'recursiveRef',
          doc,
          at: f.at,
          name: node[dynamic],
          base: loc!.base,
        })
      }
      if ('string' === typeof node) {
        if ('connection:operationId' === state) {
          use({ kind: 'operationId', doc, at: f.at, name: node, base: f.base })
        } else if ('locator:operation' === state) {
          use({ kind: 'operationRef', doc, at: f.at, name: node, base: f.base })
        } else if ('connection:tag' === state) {
          const holder = 'parent' === f.last ? f.holder : undefined
          use({
            kind: 'parent' === f.last ? 'tagParent' : 'tag',
            doc,
            at: f.at,
            name: node,
            base: f.base,
            holder: isMap(holder) && 'string' === typeof holder.name ? holder.name : undefined,
          })
        } else if ('mapping' === state) {
          use({ kind: 'defaultMapping' === f.last ? 'defaultMapping' : 'mapping', doc, at: f.at, name: node, base: f.base })
        } else if ('url' === s.kind) {
          const base = ('description' === s.type || 'retrieval' === s.type || 'api' === s.type ? s.type : 'none') as UrlUse['base']
          const row: UrlUse = { at: f.at, value: node, base }
          if (doc !== home) row.doc = doc.key
          // A server's URL with variables has no absolute form until
          // they are given.
          const uri =
            'description' === base
              ? absoluteOf(node, f.base)
              : 'retrieval' !== base
                ? absoluteOf(node, undefined)
                : /[{}]/.test(node)
                  ? undefined
                  : absoluteOf(node, doc.key)
          if (undefined !== uri) row.uri = uri
          urls.push(row)
        }
      }
      if (isMap(node)) {
        // A discriminator, which in 2.0 is the name of the property and
        // from 3.0 an object that has it.
        if ('schema' === s.kind && undefined !== loc) {
          const d = node.discriminator
          if ('2.0' === dmv ? 'string' === typeof d : isMap(d) && 'string' === typeof d.propertyName) {
            use({ kind: 'implicitMapping', doc, at: f.at + '/discriminator', name: '', base: f.base, loc, node })
          }
        }
        if ('connection:securityScheme' === s.keys) {
          for (const key of Object.keys(node)) {
            use({ kind: 'securityScheme', doc, at: f.at + '/' + esc(key), name: key, base: f.base })
          }
        }
        if ('operation' === s.type && 'object' === s.kind && 'string' === typeof node.operationId) {
          const list = declared.get(node.operationId) ?? []
          list.push({ doc, at: f.at, loc })
          declared.set(node.operationId, list)
        }
        if (('server' === s.type || 'paths' === s.type) && 'object' === s.kind) {
          const say = (row: Connection) => {
            if (doc !== home) row.doc = doc.key
            written.push([order, row])
          }
          if ('paths' === s.type) pathsOf(node, f.at, say)
          else if ('string' === typeof node.url) serverOf(node, f.at, say)
        }
        if (doc === home && 'tag' === s.type && 2 === f.depth && 'tags' === loc!.parent!.seg && 'string' === typeof node.name) {
          if (!tags.has(node.name)) {
            tags.set(node.name, { at: f.at, parent: 'string' === typeof node.parent ? node.parent : undefined })
          }
        }
      }
    }
    order++
    if (undefined === loc) continue
    const names: (string | number)[] = Array.isArray(node) ? node.map((_: any, i: number) => i) : Object.keys(node)
    for (let i = names.length - 1; 0 <= i; i--) {
      const name = names[i]
      const child = node[name]
      const kid = null != child && 'object' === typeof child ? index.child(loc, name) : undefined
      // What lies below a position the model gives no state is of
      // interest only where a reference has typed it, or something in it.
      const next = undefined !== kid ? kid.state : 'data' === state ? 'data' : step(dmv, state, name)
      if ('data' === next && (undefined === kid || !kid.holdsRegion)) continue
      stack.push({ node: child, loc: kid, at: f.at + '/' + esc(name), state: next, base: loc.base, last: name, depth: f.depth + 1, holder: node })
    }
  }
  }

  const schemes = namesAt(raw, '2.0' === mv ? ['securityDefinitions'] : ['components', 'securitySchemes'])
  const schemesAt = '2.0' === mv ? ['securityDefinitions'] : ['components', 'securitySchemes']
  const schemas = namesAt(raw, '2.0' === mv ? ['definitions'] : ['components', 'schemas'])
  const schemasAt = '2.0' === mv ? ['definitions'] : ['components', 'schemas']

  // A URI reference: located in this document, there as the document is
  // written, and of what type.
  const byUri = (name: string, base: string) => {
    const where = index.locate(name, base)
    if (null == where.target) {
      return {
        found: false,
        target: null,
        doc: undefined,
        why: (where.why ?? 'not-found') as string | undefined,
        type: null,
        node: undefined,
      }
    }
    // It may name a location in another document of the set, which is
    // typed by the model of that document's own version.
    const land = index.landingAt(where.target, where.doc)
    return {
      found: land.found,
      target: pointer(where.target),
      doc: undefined === where.doc || where.doc === index.docs[0] ? undefined : where.doc.key,
      why: land.found ? undefined : 'not-found',
      type: land.found ? slot((land.doc ?? index.docs[0]).mv, index.stateAt(land)).type : null,
      node: land.found ? land.node : undefined,
    }
  }

  // The schema components that build on a schema with `allOf`, by the
  // location of the schema built on. A reference in `allOf` names a
  // schema, and where that one is itself a reference, the one it names
  // too.
  const holder = ((): Loc | undefined => {
    let loc: Loc | undefined = index.root
    for (const seg of schemasAt) loc = undefined === loc ? undefined : index.child(loc, seg)
    return loc
  })()
  let builders: Map<Loc, string[]> | undefined
  const buildersOf = (): Map<Loc, string[]> => {
    if (undefined !== builders) return builders
    const found = new Map<Loc, string[]>()
    for (const name of undefined === holder ? [] : Object.keys(schemas)) {
      if (undefined !== tick) tick()
      const schema = schemas[name]
      const list = isMap(schema) && Array.isArray(schema.allOf) ? index.child(index.child(holder!, name)!, 'allOf') : undefined
      if (undefined === list) continue
      for (let i = 0; i < schema.allOf.length; i++) {
        let loc = index.child(list, i)
        const seen = new Set<Loc>()
        while (undefined !== loc && undefined !== loc.site && !seen.has(loc)) {
          seen.add(loc)
          const land: Landing = index.landing(loc.site)
          loc = land.found ? land.loc : undefined
          if (undefined === loc) break
          const names = found.get(loc)
          if (undefined === names) found.set(loc, [name])
          else names.push(name)
        }
      }
    }
    return (builders = found)
  }

  // The name of the schema component at a path, where it is one.
  const componentAt = (path: Path | undefined): string | undefined =>
    undefined !== path && path.length === schemasAt.length + 1 && schemasAt.every((seg, i) => seg === String(path[i]))
      ? String(path[path.length - 1])
      : undefined

  // The implicit mapping of a discriminator: the value of its property is
  // the name of a schema component, where no `mapping` entry has that
  // value. The schemas it can name are the ones listed beside it in
  // `oneOf` or `anyOf` by reference, since an inline one has no name, and
  // the components that build on its schema with `allOf`, and on those in
  // turn. In 2.0 the schema's own name is one too.
  const implied = (use: Use): Connection[] => {
    const node = use.node
    const rows: Connection[] = []
    const explicit = '2.0' !== mv && isMap(node.discriminator.mapping) ? node.discriminator.mapping : undefined
    const seen = new Set<string>()
    const add = (name: string, from: Connection['from']) => {
      if (seen.has(name) || (undefined !== explicit && own(explicit, name))) return
      seen.add(name)
      rows.push({ kind: 'implicitMapping', at: use.at, name, found: true, target: pointer([...schemasAt, name]), from })
    }
    if ('2.0' === mv) {
      const path: Path = []
      for (let p: Loc | undefined = use.loc; undefined !== p && undefined !== p.parent; p = p.parent) path.unshift(p.seg)
      const self = componentAt(path)
      if (undefined !== self) add(self, 'self')
    } else {
      for (const k of ['oneOf', 'anyOf'] as const) {
        const list = Array.isArray(node[k]) ? index.child(use.loc!, k) : undefined
        if (undefined === list) continue
        for (let i = 0; i < node[k].length; i++) {
          const item = index.child(list, i)
          if (undefined === item || undefined === item.site) continue
          const land: Landing = index.landing(item.site)
          const name = land.found ? componentAt(land.path) : undefined
          if (undefined !== name) add(name, k)
        }
      }
    }
    const built = buildersOf()
    const queue: Loc[] = [use.loc!]
    const done = new Set<Loc>()
    while (0 < queue.length) {
      const at = queue.shift()!
      if (done.has(at)) continue
      done.add(at)
      for (const name of built.get(at) ?? []) {
        add(name, 'allOf')
        const child = index.child(holder!, name)
        if (undefined !== child) queue.push(child)
      }
    }
    return rows
  }

  // An operation, as a row names it: its pointer, after its document's
  // URI where that is not the description.
  const placed = (d: { doc: DocFacts; at: string }): string => (d.doc === home ? d.at : d.doc.key + '#' + d.at)

  const out: Connection[] = []
  let next = 0
  const sorted = written.sort((a, b) => a[0] - b[0])
  for (const use of uses) {
    // What was read where it is written comes in its place in the walk.
    while (next < sorted.length && sorted[next][0] < use.order) out.push(sorted[next++][1])
    if ('implicitMapping' === use.kind) {
      // The names a discriminator's value can take are those of the
      // description's schema components, so the implicit ones are worked
      // out for the description's own schemas.
      if (use.doc === home) for (const row of implied(use)) out.push(row)
      continue
    }
    const row: Connection = { kind: use.kind, at: use.at, name: use.name, found: false, target: null }
    if (use.doc !== home) row.doc = use.doc.key
    if ('operationId' === use.kind) {
      // An operationId is looked for among the operations of every
      // document, the description's first.
      const decl = declared.get(use.name)
      if (null != decl) {
        row.found = true
        row.target = decl[0].at
        if (decl[0].doc !== home) row.targetDoc = decl[0].doc.key
        if (1 < decl.length) row.targets = decl.map(placed)
      }
    } else if ('operationRef' === use.kind || 'dynamicRef' === use.kind || 'recursiveRef' === use.kind) {
      const u = byUri(use.name, use.base)
      row.found = u.found
      row.target = u.target
      if (undefined !== u.doc) row.targetDoc = u.doc
      if (null != u.why) row.why = u.why
      if ('operationRef' === use.kind) row.type = u.type
      if ('dynamicRef' === use.kind) {
        const fragment = fragmentOf(resolveUri(use.base, use.name))
        const node = u.node
        row.anchor = null != fragment && ANCHOR.test(fragment) && isMap(node) && fragment === node.$dynamicAnchor
      }
      if ('recursiveRef' === use.kind) row.anchor = isMap(u.node) && true === u.node.$recursiveAnchor
    } else if ('securityScheme' === use.kind) {
      if (own(schemes, use.name)) {
        row.found = true
        row.target = pointer([...schemesAt, use.name])
        row.via = 'name'
        if ('3.2' === use.doc.mv) {
          const u = byUri(use.name, use.base)
          if (u.found && 'securityScheme' === u.type) row.ambiguous = true
        }
      } else if ('3.2' === use.doc.mv) {
        const u = byUri(use.name, use.base)
        row.found = u.found
        row.target = u.target
        if (undefined !== u.doc) row.targetDoc = u.doc
        row.via = 'uri'
        row.type = u.type
        if (null != u.why) row.why = u.why
      }
    } else if ('tag' === use.kind || 'tagParent' === use.kind) {
      const tag = tags.get(use.name)
      if (null != tag) {
        row.found = true
        row.target = tag.at
      }
      if ('tagParent' === use.kind) {
        const seen = new Set<string>(null == use.holder ? [] : [use.holder])
        let cur: string | undefined = use.name
        let cycle = false
        while (null != cur) {
          if (seen.has(cur)) {
            cycle = true
            break
          }
          seen.add(cur)
          cur = tags.get(cur)?.parent
        }
        if (cycle) row.cycle = true
      }
    } else if ('mapping' === use.kind || 'defaultMapping' === use.kind) {
      if (own(schemas, use.name)) {
        row.found = true
        row.target = pointer([...schemasAt, use.name])
        row.via = 'name'
      } else {
        const u = byUri(use.name, use.base)
        row.found = u.found
        row.target = u.target
        if (undefined !== u.doc) row.targetDoc = u.doc
        row.via = 'uri'
        if (null != u.why) row.why = u.why
      }
    }
    out.push(row)
  }
  while (next < sorted.length) out.push(sorted[next++][1])
  return { rows: out, urls, declared }
}

// A server's URL: each variable between its braces names one the Server
// Object declares. One named twice is said, and so is a URL whose braces
// are no template's, or that has a query or a fragment.
function serverOf(node: Record<string, any>, at: string, say: (row: Connection) => void): void {
  const url = node.url as string
  const where = at + '/url'
  let parts: TemplatePart[]
  try {
    parts = readTemplate(url, 'server').parts
  } catch (err) {
    if (!(err instanceof ExpressionError)) throw err
    say({ kind: 'template', at: where, name: url, found: false, target: null, why: 'malformed' })
    return
  }
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const part of parts) {
    if (!('name' in part)) continue
    if (seen.has(part.name)) {
      if (!twice.has(part.name)) say({ kind: 'template', at: where, name: part.name, found: false, target: null, why: 'repeated' })
      twice.add(part.name)
      continue
    }
    seen.add(part.name)
    const found = isMap(node.variables) && own(node.variables, part.name)
    say({
      kind: 'serverVariable',
      at: where,
      name: part.name,
      found,
      target: found ? at + '/variables/' + esc(part.name) : null,
    })
  }
  // What is between braces is a name, whatever characters it has.
  const literal = parts.map((part) => ('literal' in part ? part.literal : '')).join('')
  for (const [mark, why] of [['?', 'query'], ['#', 'fragment']] as const) {
    if (literal.includes(mark)) say({ kind: 'template', at: where, name: url, found: false, target: null, why })
  }
}

// The paths of a Paths Object: each is a template that starts with a
// slash and names no parameter twice, and no two are one template under
// other names, which the specification calls identical.
function pathsOf(node: Record<string, any>, at: string, say: (row: Connection) => void): void {
  const same = new Map<string, string[]>()
  for (const key of Object.keys(node)) {
    if (key.startsWith('x-')) continue
    const where = at + '/' + esc(key)
    if (!key.startsWith('/')) say({ kind: 'template', at: where, name: key, found: false, target: null, why: 'no-slash' })
    let parts: TemplatePart[]
    try {
      parts = readTemplate(key, 'path').parts
    } catch (err) {
      if (!(err instanceof ExpressionError)) throw err
      say({ kind: 'template', at: where, name: key, found: false, target: null, why: 'malformed' })
      continue
    }
    const names = namesOf({ template: key, kind: 'path', parts })
    for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
      say({ kind: 'template', at: where, name, found: false, target: null, why: 'repeated' })
    }
    if (0 === names.length) continue
    const shape = parts.map((part) => ('literal' in part ? part.literal : '{}')).join('')
    const list = same.get(shape)
    if (undefined === list) same.set(shape, [where])
    else list.push(where)
  }
  for (const [shape, list] of same) {
    if (1 < list.length) say({ kind: 'pathClash', at: list[0], name: shape, found: true, target: list[0], routes: list })
  }
}

// Every route through paths, webhooks and callbacks that reaches an
// operation, grouped by operationId: an id that more than one route
// reaches names more than one operation in the API. The routes are
// walked on the document. A reference on the way stands for what it lands
// on, so a path item reached through a `$ref` counts once per route, and
// a Path Item's own fields beside its `$ref` are walked with those of the
// Path Item it names. That holds for every site the index has: under
// `slots: 'all'` a `$ref` where the model puts an operation is one. A
// reference that lands nowhere is walked as it is written, and a route
// that comes back to a value it is already in ends there.
//
// A value that two routes reach is walked once for each, so the walk can
// be far longer than the document: callbacks that branch to a shared Path
// Item double the routes at every level. Every visit is a step of the
// caller's count, where one is kept. Kept or not, the visits are held to
// the index's allowance, and past it the walk ends as `openapi_work`.
function reuseOf(
  raw: any,
  mv: ModelVersion,
  index: SiteIndex,
  refuse: (code: string, message: string, at: string) => never,
  tick?: () => void,
): Connection[] {
  const routes = new Map<string, string[]>()
  let visits = 0
  const onPath = new Set<any>()
  type Member = { value: any; loc: Loc | undefined }
  type Frame = { node: any; loc: Loc | undefined; at: string; state: string; leaving: boolean }
  const stack: Frame[] = [{ node: raw, loc: index.root, at: '', state: 'root', leaving: false }]
  while (0 < stack.length) {
    const f = stack.pop()!
    if (f.leaving) {
      onPath.delete(f.node)
      continue
    }
    if (null == f.node || 'object' !== typeof f.node) continue
    if (undefined !== tick) tick()
    if (index.allowance < ++visits) {
      refuse(
        'openapi_work',
        'walking the routes of this document takes more than ' + EXTRA_FACTOR + ' times the work of reading it once',
        f.at,
      )
    }
    const s = slot(mv, f.state)
    if ('schema' === s.kind) continue
    // What a reference here stands for, and the fields a Path Item has
    // beside its `$ref`, the outermost winning.
    let node = f.node
    let loc = f.loc
    let beside: Record<string, Member> | undefined
    const followed = new Set<Loc>()
    while (undefined !== loc && undefined !== loc.site) {
      const land: Landing = index.landing(loc.site)
      if (!land.found || followed.has(loc)) {
        // A reference that names nothing is as it is written, and so is
        // one that names it.
        node = f.node
        loc = f.loc
        beside = undefined
        break
      }
      followed.add(loc)
      if ('pathItem' === loc.site.kind && isMap(node)) {
        for (const k of Object.keys(node)) {
          if ('$ref' === k) continue
          beside ??= Object.create(null) as Record<string, Member>
          if (!own(beside, k)) beside[k] = { value: node[k], loc: index.child(loc, k) }
        }
      }
      node = land.node
      loc = land.loc
    }
    if (null == node || 'object' !== typeof node || onPath.has(node)) continue
    if ('operation' === s.type && 'object' === s.kind && isMap(node) && 'string' === typeof node.operationId) {
      const list = routes.get(node.operationId) ?? []
      list.push(f.at)
      routes.set(node.operationId, list)
    }
    onPath.add(node)
    stack.push({ node, loc: undefined, at: f.at, state: f.state, leaving: true })
    const names: (string | number)[] = Array.isArray(node) ? node.map((_: any, i: number) => i) : Object.keys(node)
    if (undefined !== beside) for (const k of Object.keys(beside)) if (!own(node, k)) names.push(k)
    for (let i = names.length - 1; 0 <= i; i--) {
      const name = names[i]
      if ('' === f.at && 'components' === name) continue
      const next = step(mv, f.state, name)
      if ('data' === next) continue
      const from = undefined !== beside && own(beside, String(name)) ? beside[String(name)] : undefined
      stack.push({
        node: undefined !== from ? from.value : node[name],
        loc: undefined !== from ? from.loc : undefined === loc ? undefined : index.child(loc, name),
        at: f.at + '/' + esc(name),
        state: next,
        leaving: false,
      })
    }
  }
  const out: Connection[] = []
  for (const [name, list] of routes) {
    if (1 < list.length) {
      out.push({ kind: 'operationIdReuse', at: list[0], name, found: true, target: list[0], routes: list })
    }
  }
  return out
}

export { connectionsOf, reuseOf }

export type { Connection, ConnectionKind, UrlUse }
