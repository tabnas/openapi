/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The connections report: every place a description names something
// other than through `$ref`, and whether what it names is there. A Link
// names an operation by operationId, or locates one with operationRef; a
// Security Requirement's member names name security schemes; an
// operation's tags name tags; a 3.2 tag names its parent; a Discriminator
// maps payload values to schemas by name or URI; a `$dynamicRef` has an
// initial target. Nothing here is substituted into the tree: the report
// says what each name reaches, and the caller decides.
//
// Everything here is read from the site index (site-index.ts), which has
// the type of every location, the base URI it is read under, and where a
// path lands. So a name inside example data is data; a name in a region
// that only a reference types is found; and whether a target is there is
// judged on the document as written, with a step that is missing at a
// reference read in what that reference names. None of it depends on the
// shape the caller asked the resolved tree in.

import { slot, step } from './model'
import type { ModelVersion } from './model'
import type { Landing, Loc, SiteIndex } from './site-index'
import { ANCHOR, NOTHING, fragmentOf, isMap, own, pointer, resolveUri, stepInto } from './uri'
import type { Path } from './uri'

type ConnectionKind =
  | 'operationId'
  | 'operationRef'
  | 'securityScheme'
  | 'tag'
  | 'tagParent'
  | 'mapping'
  | 'defaultMapping'
  | 'dynamicRef'
  | 'pathItemMerge'
  | 'operationIdReuse'

// One connection: the position that names something (`at`), the name or
// URI as written, whether its target is there, and where. The other
// members appear only for the kinds they belong to.
type Connection = {
  kind: ConnectionKind
  at: string
  name: string
  found: boolean
  target: string | null
  // Why a URI found nothing: as the resolver's unresolved reasons.
  why?: string
  // The object-model type at a located target: operationRef must reach
  // an `operation`, a security requirement URI a `securityScheme`.
  type?: string | null
  // How a security requirement key or a mapping value was read.
  via?: 'name' | 'uri'
  // A 3.2 security requirement key that is a security scheme's name and
  // also locates one as a URI; the name wins.
  ambiguous?: boolean
  // Every operation that declares an operationId a Link names, when more
  // than one does.
  targets?: string[]
  // A 3.2 tag whose chain of parents loops.
  cycle?: boolean
  // A `$dynamicRef` whose initial target has a `$dynamicAnchor` of the
  // fragment's name.
  anchor?: boolean
  // A Path Item `$ref`'s fields that are also in the Path Item it names,
  // where the specification leaves the merge undefined.
  fields?: string[]
  // Every route through paths, webhooks and callbacks that reaches an
  // operation with one operationId, when there is more than one.
  routes?: string[]
}

type Use = { kind: ConnectionKind; at: string; name: string; base: string; holder?: string }

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

function connectionsOf(raw: any, mv: ModelVersion, index: SiteIndex, hasIds: boolean, tick?: () => void): Connection[] {
  // A root that is neither a map nor a list names nothing.
  if (!Array.isArray(raw) && !isMap(raw)) return []
  const uses: Use[] = []
  const declared = new Map<string, string[]>()
  const tags = new Map<string, { at: string; parent?: string }>()

  // Every position the index types, in document order, a container before
  // its members. A value that is neither a map nor a list has no location
  // of its own: its state is its parent's step to it, and it is read under
  // its parent's base URI.
  type Frame = { node: any; loc: Loc | undefined; at: string; state: string; base: string; last: string | number; depth: number; holder: any }
  const stack: Frame[] = [{ node: raw, loc: index.root, at: '', state: 'root', base: '', last: '', depth: 0, holder: undefined }]
  while (0 < stack.length) {
    const f = stack.pop()!
    if (undefined !== tick) tick()
    const node = f.node
    const loc = f.loc
    const state = undefined !== loc ? loc.state : f.state
    if ('data' !== state) {
      const s = slot(mv, state)
      if ('schema' === s.kind && hasIds && isMap(node) && 'string' === typeof node.$dynamicRef) {
        uses.push({ kind: 'dynamicRef', at: f.at, name: node.$dynamicRef, base: loc!.base })
      }
      if ('string' === typeof node) {
        if ('connection:operationId' === state) {
          uses.push({ kind: 'operationId', at: f.at, name: node, base: f.base })
        } else if ('locator:operation' === state) {
          uses.push({ kind: 'operationRef', at: f.at, name: node, base: f.base })
        } else if ('connection:tag' === state) {
          const holder = 'parent' === f.last ? f.holder : undefined
          uses.push({
            kind: 'parent' === f.last ? 'tagParent' : 'tag',
            at: f.at,
            name: node,
            base: f.base,
            holder: isMap(holder) && 'string' === typeof holder.name ? holder.name : undefined,
          })
        } else if ('mapping' === state) {
          uses.push({ kind: 'defaultMapping' === f.last ? 'defaultMapping' : 'mapping', at: f.at, name: node, base: f.base })
        }
      }
      if (isMap(node)) {
        if ('connection:securityScheme' === s.keys) {
          for (const key of Object.keys(node)) {
            uses.push({ kind: 'securityScheme', at: f.at + '/' + esc(key), name: key, base: f.base })
          }
        }
        if ('operation' === s.type && 'object' === s.kind && 'string' === typeof node.operationId) {
          const list = declared.get(node.operationId) ?? []
          list.push(f.at)
          declared.set(node.operationId, list)
        }
        if ('tag' === s.type && 2 === f.depth && 'tags' === loc!.parent!.seg && 'string' === typeof node.name) {
          if (!tags.has(node.name)) {
            tags.set(node.name, { at: f.at, parent: 'string' === typeof node.parent ? node.parent : undefined })
          }
        }
      }
    }
    if (undefined === loc) continue
    const names: (string | number)[] = Array.isArray(node) ? node.map((_: any, i: number) => i) : Object.keys(node)
    for (let i = names.length - 1; 0 <= i; i--) {
      const name = names[i]
      const child = node[name]
      const kid = null != child && 'object' === typeof child ? index.child(loc, name) : undefined
      // What lies below a position the model gives no state is of
      // interest only where a reference has typed it, or something in it.
      const next = undefined !== kid ? kid.state : 'data' === state ? 'data' : step(mv, state, name)
      if ('data' === next && (undefined === kid || !kid.holdsRegion)) continue
      stack.push({ node: child, loc: kid, at: f.at + '/' + esc(name), state: next, base: loc.base, last: name, depth: f.depth + 1, holder: node })
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
      return { found: false, target: null, why: (where.why ?? 'not-found') as string | undefined, type: null, node: undefined }
    }
    const land = index.landingAt(where.target)
    return {
      found: land.found,
      target: pointer(where.target),
      why: land.found ? undefined : 'not-found',
      type: land.found ? slot(mv, index.stateAt(land)).type : null,
      node: land.found ? land.node : undefined,
    }
  }

  const out: Connection[] = []
  for (const use of uses) {
    const row: Connection = { kind: use.kind, at: use.at, name: use.name, found: false, target: null }
    if ('operationId' === use.kind) {
      const decl = declared.get(use.name)
      if (null != decl) {
        row.found = true
        row.target = decl[0]
        if (1 < decl.length) row.targets = decl
      }
    } else if ('operationRef' === use.kind || 'dynamicRef' === use.kind) {
      const u = byUri(use.name, use.base)
      row.found = u.found
      row.target = u.target
      if (null != u.why) row.why = u.why
      if ('operationRef' === use.kind) row.type = u.type
      if ('dynamicRef' === use.kind) {
        const fragment = fragmentOf(resolveUri(use.base, use.name))
        const node = u.node
        row.anchor = null != fragment && ANCHOR.test(fragment) && isMap(node) && fragment === node.$dynamicAnchor
      }
    } else if ('securityScheme' === use.kind) {
      if (own(schemes, use.name)) {
        row.found = true
        row.target = pointer([...schemesAt, use.name])
        row.via = 'name'
        if ('3.2' === mv) {
          const u = byUri(use.name, use.base)
          if (u.found && 'securityScheme' === u.type) row.ambiguous = true
        }
      } else if ('3.2' === mv) {
        const u = byUri(use.name, use.base)
        row.found = u.found
        row.target = u.target
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
        row.via = 'uri'
        if (null != u.why) row.why = u.why
      }
    }
    out.push(row)
  }
  return out
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
// be far longer than the document: every visit is a step of the caller's
// count, where one is kept.
function reuseOf(raw: any, mv: ModelVersion, index: SiteIndex, tick?: () => void): Connection[] {
  const routes = new Map<string, string[]>()
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

export type { Connection, ConnectionKind }
