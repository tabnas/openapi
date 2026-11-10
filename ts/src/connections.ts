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
// The names are found by walking the raw tree with the object model, so a
// name inside example data is data. Whether a target exists is checked in
// the resolved tree, so a target reached through a `$ref` is found.

import { classify, slot, step, walkModel } from './model'
import type { ModelVersion } from './model'
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

// How resolve reads a URI reference: the target in this document, or why
// there is none.
type Locate = (ref: string, base: string) => { target?: Path; why?: string }

type Use = { kind: ConnectionKind; at: string; name: string; base: string; holder?: string }

// The value at a path in the resolved tree, or NOTHING.
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
  tree: any,
  mv: ModelVersion,
  docBase: string,
  locate: Locate,
  hasIds: boolean,
): Connection[] {
  const uses: Use[] = []
  const declared = new Map<string, string[]>()
  const tags = new Map<string, { at: string; parent?: string }>()

  walkModel<string>(mv, raw, docBase, (node, path, state, base) => {
    const s = slot(mv, state)
    let mine = base
    if ('schema' === s.kind && hasIds && isMap(node)) {
      if ('string' === typeof node.$id) mine = resolveUri(base, node.$id)
      if ('string' === typeof node.$dynamicRef) {
        uses.push({ kind: 'dynamicRef', at: pointer(path), name: node.$dynamicRef, base: mine })
      }
    }
    const last = path[path.length - 1]
    if ('string' === typeof node) {
      if ('connection:operationId' === state) {
        uses.push({ kind: 'operationId', at: pointer(path), name: node, base })
      } else if ('locator:operation' === state) {
        uses.push({ kind: 'operationRef', at: pointer(path), name: node, base })
      } else if ('connection:tag' === state) {
        const holder = 'parent' === last ? reach(raw, path.slice(0, -1)) : undefined
        uses.push({
          kind: 'parent' === last ? 'tagParent' : 'tag',
          at: pointer(path),
          name: node,
          base,
          holder: isMap(holder) && 'string' === typeof holder.name ? holder.name : undefined,
        })
      } else if ('mapping' === state) {
        uses.push({ kind: 'defaultMapping' === last ? 'defaultMapping' : 'mapping', at: pointer(path), name: node, base })
      }
    }
    if (isMap(node)) {
      if ('connection:securityScheme' === s.keys) {
        for (const key of Object.keys(node)) {
          uses.push({ kind: 'securityScheme', at: pointer([...path, key]), name: key, base })
        }
      }
      if ('operation' === s.type && 'object' === s.kind && 'string' === typeof node.operationId) {
        const list = declared.get(node.operationId) ?? []
        list.push(pointer(path))
        declared.set(node.operationId, list)
      }
      if ('tag' === s.type && 2 === path.length && 'tags' === path[0] && 'string' === typeof node.name) {
        if (!tags.has(node.name)) {
          tags.set(node.name, { at: pointer(path), parent: 'string' === typeof node.parent ? node.parent : undefined })
        }
      }
    }
    return mine
  })

  const schemes = namesAt(raw, '2.0' === mv ? ['securityDefinitions'] : ['components', 'securitySchemes'])
  const schemesAt = '2.0' === mv ? ['securityDefinitions'] : ['components', 'securitySchemes']
  const schemas = namesAt(raw, '2.0' === mv ? ['definitions'] : ['components', 'schemas'])
  const schemasAt = '2.0' === mv ? ['definitions'] : ['components', 'schemas']

  // A URI reference: located in this document, there in the resolved
  // tree, and of what type.
  const byUri = (name: string, base: string) => {
    const where = locate(name, base)
    if (null == where.target) return { found: false, target: null, why: where.why ?? 'not-found', type: null }
    const there = NOTHING !== reach(tree, where.target)
    return {
      found: there,
      target: pointer(where.target),
      why: there ? undefined : 'not-found',
      type: there ? classify(mv, where.target).type : null,
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
        const node = u.found && null != u.target ? reach(tree, pointerPath(u.target)) : undefined
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
// operation, walked in the resolved tree so a path item reached through a
// `$ref` counts once per route, and grouped by operationId: an id that
// more than one route reaches names more than one operation in the API.
function reuseOf(tree: any, mv: ModelVersion): Connection[] {
  const routes = new Map<string, string[]>()
  const onPath = new Set<any>()
  const stack: [any, Path, string, boolean][] = [[tree, [], 'root', false]]
  while (0 < stack.length) {
    const [node, path, state, leaving] = stack.pop()!
    if (leaving) {
      onPath.delete(node)
      continue
    }
    if (null == node || 'object' !== typeof node || onPath.has(node)) continue
    const s = slot(mv, state)
    if ('schema' === s.kind) continue
    if ('operation' === s.type && 'object' === s.kind && isMap(node) && 'string' === typeof node.operationId) {
      const list = routes.get(node.operationId) ?? []
      list.push(pointer(path))
      routes.set(node.operationId, list)
    }
    onPath.add(node)
    stack.push([node, path, state, true])
    const names: (string | number)[] = Array.isArray(node) ? node.map((_: any, i: number) => i) : Object.keys(node)
    for (let i = names.length - 1; 0 <= i; i--) {
      if (0 === path.length && 'components' === names[i]) continue
      const next = step(mv, state, names[i])
      if ('data' !== next) stack.push([node[names[i]], [...path, names[i]], next, false])
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

// RFC 6901 back to segments, for a pointer this module made.
function pointerPath(p: string): Path {
  if ('' === p) return []
  return p
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

export { connectionsOf, reuseOf }

export type { Connection, ConnectionKind, Locate }
