/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The operation as the specification reads it. An Operation Object does
// not say everything about its operation: its Path Item gives it
// parameters, which it may override by name and location; its servers
// are its own, else its Path Item's, else the root's; its security is
// its own, else the root's; and in 2.0 its `consumes`, `produces` and
// `schemes` are its own, else the root's. A reader that takes the
// Operation Object alone has the wrong operation.
//
// This walks every route to an operation, through `paths`, `webhooks`
// and the callbacks of operations, and says for each what applies to it
// and where that is. With it come three things that are read off the
// same walk:
//
// - the `ignored` report: the header parameters named `Accept`,
//   `Content-Type` and `Authorization`, and a header named `Content-Type`
//   of a response or of an encoding, each of which the specification
//   says to ignore;
// - a path's template expressions held to the path parameters of each
//   operation under it;
// - the runtime expressions of a Link and of a Callback's key held to the
//   parameters of the operation they belong to, and a Link's parameter
//   names to the operation the Link names.
//
// The routes are walked on the document as written, as the `connections`
// report's own walk is: a reference on the way stands for what it lands
// on, by the site index, so none of this depends on the shape the caller
// asked the resolved tree in. A Path Item's own fields beside its `$ref`
// are read with those of the Path Item it names, its own winning, and so
// are the members beside any reference under `siblings: 'merge'`. What a
// row gives as a value is read from the resolved tree afterwards, at the
// row's route.
//
// A value that two routes reach is walked once for each, so the walk is
// held to the index's allowance, as that other walk is.

import { slot, step } from './model'
import type { ModelVersion } from './model'
import { ExpressionError, namesOf, readExpression, readTemplate } from './expression'
import type { Expression } from './expression'
import { EXTRA_FACTOR, pathOf } from './site-index'
import type { DocFacts, Landing, Loc, SiteIndex } from './site-index'
import { NOTHING, isMap, own, pointer, stepInto } from './uri'
import type { Path } from './uri'
import type { Connection } from './connections'

// Which object gave an operation a list: itself, its Path Item, or the
// root. `default` is the one server the specification gives an API that
// names none, and `none` a list that nothing gives.
type From = 'operation' | 'pathItem' | 'root' | 'default' | 'none'

// One parameter of an operation, after its Path Item's are inherited.
type ParameterView = {
  name: string
  in: string
  // Where the resolved tree has it: in the operation's own list, or in
  // its Path Item's.
  at: string
  from: 'operation' | 'pathItem'
  // The Parameter Object as the resolved tree has it there.
  parameter: any
}

// A list an operation has from itself or from above it.
type Inherited = {
  from: From
  // Where the resolved tree has the list, or null where no object gives
  // one.
  at: string | null
  // The list as the resolved tree has it there. For `default`, the one
  // Server Object the specification gives, and for `none` an empty list.
  value: any[]
}

// One operation of the API, with what applies to it.
type OperationView = {
  // Where the resolved tree has the operation: its route from the root.
  at: string
  // How it is reached: under `paths`, under `webhooks`, or as a callback
  // of another operation.
  kind: 'path' | 'webhook' | 'callback'
  // For `path`, the path as written.
  path?: string
  // For `webhook`, the webhook's name. For `callback`, the callback's.
  name?: string
  // For `callback`, the key it is under, which is a runtime expression,
  // and the operation it is a callback of, by that one's `at`.
  expression?: string
  of?: string
  // The HTTP method: of a fixed field in capitals, and of a member of
  // `additionalOperations` as it is written there.
  method: string
  additional?: true
  operationId?: string
  // The Operation Object as the resolved tree has it at `at`. Undefined
  // where a reference on the way is left as written there: one that
  // closes a cycle, or one kept under `sharing: 'inline-once'`.
  operation: any
  // The Path Item's parameters that the operation does not override,
  // then the operation's own. One the specification says to ignore is in
  // neither, and in the `ignored` report.
  parameters: ParameterView[]
  // One of the parameters is a reference that is left as written, so the
  // list lacks it.
  partial?: true
  // Not in 2.0, which has no servers.
  servers?: Inherited
  security: Inherited
  // In 2.0 alone.
  consumes?: Inherited
  produces?: Inherited
  schemes?: Inherited
}

// Something the specification says to ignore.
type Ignored = {
  // Where the resolved tree has it.
  at: string
  what: 'parameter' | 'responseHeader' | 'encodingHeader'
  // Its name as written.
  name: string
  // For a parameter: how its operation or Path Item is reached, the path
  // where that is under `paths`, the method where the list is an
  // operation's and not the Path Item's own, and its place in the list.
  kind?: 'path' | 'webhook' | 'callback'
  path?: string
  method?: string
  additional?: true
  index?: number
}

// The three header names a parameter may not describe: the request body,
// the responses and the security schemes say those.
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization'])

// The locations a Link's parameter name may be qualified with.
const LOCATIONS = new Set(['path', 'query', 'header', 'cookie'])

type Member = { value: any; loc: Loc | undefined }

// A value on a route: what the value as written stands for once every
// reference is followed, its location, and the members a reference on
// the way had of its own. `left` is a reference that could not be
// followed: one that names nothing here, or a `$ref` where the object
// model puts none.
type Seen = { node: any; loc: Loc | undefined; beside?: Record<string, Member>; left?: true }

// The parameters of a list, and whether one of its entries is a
// reference that could not be followed, and so may be any parameter.
type Params = { list: Param[]; open: boolean }

type Param = {
  name: string
  in: string
  // What makes it one parameter: its location and its name, a header's
  // without regard to case.
  key: string
  route: Path
  index: number
  from: 'operation' | 'pathItem'
  // The document it is in, where it is read off no route and that is not
  // the description.
  doc?: string
  seen: Seen
}

type Lot = { from: From; route: Path | null }

// What applies to an operation: its parameters, and whether one of them
// is behind a reference that could not be followed.
type Applies = { params: Param[]; open: boolean }

type OperationFacts = {
  route: Path
  kind: 'path' | 'webhook' | 'callback'
  path?: string
  name?: string
  expression?: string
  of?: Path
  method: string
  additional: boolean
  partial: boolean
  operationId?: string
  parameters: Param[]
  servers?: Lot
  security: Lot
  consumes?: Lot
  produces?: Lot
  schemes?: Lot
}

type IgnoredFacts = Omit<Ignored, 'at'> & { route: Path }

type Config = {
  // Whether the members beside any reference are read with what it
  // names, as `siblings: 'merge'` resolves them.
  merge: boolean
  // The deepest callbacks may nest.
  maxDepth: number
  // The operations that declare each operationId, the description's
  // first, from the `connections` report.
  declared: Map<string, { doc: DocFacts; at: string; loc: Loc | undefined }[]>
  refuse: (code: string, message: string, at: string) => never
  tick?: () => void
}

type Found = { operations: OperationFacts[]; ignored: IgnoredFacts[]; rows: Connection[] }

function operationsOf(raw: any, mv: ModelVersion, index: SiteIndex, cfg: Config): Found {
  const { merge, maxDepth, declared, refuse, tick } = cfg
  const operations: OperationFacts[] = []
  const ignored: IgnoredFacts[] = []
  // Each row with its place in the walk, which is the order of the report.
  const rows: [number, Connection][] = []
  if (!isMap(raw)) return { operations, ignored, rows: [] }
  const home = index.docs[0]
  const threeX = '2.0' !== mv

  let visits = 0
  const visit = (route: Path) => {
    if (undefined !== tick) tick()
    if (index.allowance < ++visits) {
      refuse(
        'openapi_work',
        'reading the operations of this document takes more than ' + EXTRA_FACTOR + ' times the work of reading it once',
        pointer(route),
      )
    }
  }

  // What a value stands for: itself, or what its reference lands on, and
  // so on. A reference that lands nowhere is as it is written, and so is
  // one that names it.
  const stand = (value: any, loc: Loc | undefined, route: Path): Seen => {
    visit(route)
    let node = value
    let at = loc
    let beside: Record<string, Member> | undefined
    let followed: Set<Loc> | undefined
    while (undefined !== at && undefined !== at.site) {
      const land: Landing = index.landing(at.site)
      if (!land.found || true === followed?.has(at)) return { node: value, loc, left: true }
      ;(followed ??= new Set()).add(at)
      if (('pathItem' === at.site.kind || merge) && isMap(node)) {
        for (const k of Object.keys(node)) {
          if ('$ref' === k) continue
          beside ??= Object.create(null) as Record<string, Member>
          if (!own(beside, k)) beside[k] = { value: node[k], loc: index.child(at, k) }
        }
      }
      node = land.node
      at = land.loc
    }
    const seen: Seen = undefined === beside ? { node, loc: at } : { node, loc: at, beside }
    // A `$ref` map that the object model reads as data, which nothing
    // followed.
    if (undefined !== at && at.slot) seen.left = true
    return seen
  }

  const member = (s: Seen, name: string | number): Member | undefined => {
    const key = String(name)
    if (undefined !== s.beside && own(s.beside, key)) return s.beside[key]
    const v = stepInto(s.node, name)
    if (NOTHING === v) return undefined
    return { value: v, loc: undefined === s.loc || null == v || 'object' !== typeof v ? undefined : index.child(s.loc, name) }
  }

  const namesIn = (s: Seen | undefined): string[] => {
    if (undefined === s) return []
    const map = isMap(s.node)
    const names = map ? Object.keys(s.node) : []
    if (undefined !== s.beside) for (const k of Object.keys(s.beside)) if (!map || !own(s.node, k)) names.push(k)
    return names
  }

  // A member, as what it stands for. `route` is the holder's.
  const get = (s: Seen | undefined, name: string | number, route: Path): Seen | undefined => {
    if (undefined === s) return undefined
    const m = member(s, name)
    return undefined === m ? undefined : stand(m.value, m.loc, [...route, name])
  }

  // The version whose model a value is read by: that of the document it
  // is written in.
  const versionOf = (s: Seen): ModelVersion => s.loc?.doc.mv ?? mv

  const has = (v: ModelVersion, state: string, name: string): boolean => 'data' !== step(v, state, name)

  let ord = 0
  const say = (row: Connection) => rows.push([ord++, row])

  const isIgnored = (p: Param): boolean => threeX && 'header' === p.in && IGNORED_HEADERS.has(p.name.toLowerCase())

  // The parameters a list holds that have a name and a location. One
  // that has not, a reference that names nothing among them, is no
  // parameter this can place.
  const paramsOf = (holder: Seen, route: Path, from: 'operation' | 'pathItem', doc?: string): Params => {
    const list = member(holder, 'parameters')
    const out: Param[] = []
    let open = false
    if (undefined === list || !Array.isArray(list.value)) return { list: out, open }
    for (let i = 0; i < list.value.length; i++) {
      const at = [...route, 'parameters', i]
      const entry = stand(list.value[i], undefined === list.loc ? undefined : index.child(list.loc, i), at)
      const name = member(entry, 'name')?.value
      const where = member(entry, 'in')?.value
      if ('string' !== typeof name || 'string' !== typeof where) {
        if (entry.left) open = true
        continue
      }
      const p: Param = {
        name,
        in: where,
        key: where + '\n' + ('header' === where ? name.toLowerCase() : name),
        route: at,
        index: i,
        from,
        seen: entry,
      }
      if (undefined !== doc) p.doc = doc
      out.push(p)
    }
    return { list: out, open }
  }

  // The Path Item's parameters that the operation does not override,
  // then the operation's own.
  const inherit = (item: Param[], op: Param[]): Param[] => {
    const overridden = new Set(op.map((p) => p.key))
    return [...item.filter((p) => !overridden.has(p.key)), ...op]
  }

  const sameName = (p: Param, name: string): boolean =>
    'header' === p.in ? p.name.toLowerCase() === name.toLowerCase() : p.name === name

  // The runtime expressions in a Link's value: the value itself, or the
  // ones between braces in it. A value that is no expression is a
  // constant, which the specification allows there.
  const expressionsIn = (value: string): Expression[] => {
    const out: Expression[] = []
    const read = (text: string) => {
      try {
        out.push(readExpression(text))
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err
      }
    }
    if ('$' === value[0]) read(value)
    if (0 === out.length) for (const m of value.matchAll(/\{(\$[^{}]*)\}/g)) read(m[1])
    return out
  }

  // An expression that names a parameter of the request is held to the
  // parameters of the operation it belongs to, which must declare it. A
  // header the specification says a parameter may not describe has no
  // declaration to be held to.
  const checkExpression = (e: Expression, route: Path, applies: Applies) => {
    if ('request' !== e.source || undefined === e.kind || 'body' === e.kind) return
    if ('header' === e.kind && IGNORED_HEADERS.has(e.name!.toLowerCase())) return
    const hit = applies.params.find((p) => p.in === e.kind && sameName(p, e.name!))
    const row: Connection = {
      kind: 'expression',
      at: pointer(route),
      name: e.expression,
      found: undefined !== hit,
      target: undefined === hit ? null : pointer(hit.route),
    }
    // It may be the parameter that a reference left as written names.
    if (undefined === hit && applies.open) row.why = 'unresolved'
    say(row)
  }

  // A header named Content-Type among the headers of a response or of an
  // encoding.
  const contentType = (holder: Seen | undefined, route: Path, what: 'responseHeader' | 'encodingHeader') => {
    const headers = get(holder, 'headers', route)
    for (const name of namesIn(headers)) {
      if ('content-type' === name.toLowerCase()) ignored.push({ route: [...route, 'headers', name], what, name })
    }
  }

  const encodingOf = (enc: Seen | undefined, route: Path, v: ModelVersion, depth: number) => {
    if (undefined === enc || !isMap(enc.node) || 64 < depth) return
    contentType(enc, route, 'encodingHeader')
    encodingsIn(enc, route, 'encoding', v, depth + 1)
  }

  // The Encoding Objects a Media Type Object or an Encoding Object
  // holds, by the members its version has for them.
  const encodingsIn = (holder: Seen, route: Path, state: string, v: ModelVersion, depth: number) => {
    if (has(v, state, 'encoding')) {
      const map = get(holder, 'encoding', route)
      for (const name of namesIn(map)) encodingOf(get(map, name, [...route, 'encoding']), [...route, 'encoding', name], v, depth)
    }
    if (has(v, state, 'prefixEncoding')) {
      const list = get(holder, 'prefixEncoding', route)
      if (undefined !== list && Array.isArray(list.node)) {
        for (let i = 0; i < list.node.length; i++) {
          encodingOf(get(list, i, [...route, 'prefixEncoding']), [...route, 'prefixEncoding', i], v, depth)
        }
      }
    }
    if (has(v, state, 'itemEncoding')) encodingOf(get(holder, 'itemEncoding', route), [...route, 'itemEncoding'], v, depth)
  }

  const contentOf = (holder: Seen | undefined, route: Path, v: ModelVersion) => {
    const content = get(holder, 'content', route)
    for (const type of namesIn(content)) {
      const media = get(content, type, [...route, 'content'])
      if (undefined !== media && isMap(media.node)) encodingsIn(media, [...route, 'content', type], 'mediaType', v, 0)
    }
  }

  // The operations met, each by its location as written, with what
  // applies to it there: a Link is held to the operation it names.
  const byLoc = new Map<Loc, Applies>()
  const pending: { link: Seen; route: Path; keys: string[]; ord: number }[] = []

  const linkOf = (link: Seen | undefined, route: Path, params: Applies) => {
    if (undefined === link || !isMap(link.node)) return
    const given = get(link, 'parameters', route)
    const keys = undefined !== given && isMap(given.node) ? namesIn(given) : []
    for (const key of keys) {
      const value = member(given!, key)?.value
      if ('string' === typeof value) for (const e of expressionsIn(value)) checkExpression(e, [...route, 'parameters', key], params)
    }
    const body = member(link, 'requestBody')?.value
    if ('string' === typeof body) for (const e of expressionsIn(body)) checkExpression(e, [...route, 'requestBody'], params)
    if (0 < keys.length) {
      pending.push({ link, route, keys, ord })
      ord += keys.length
    }
  }

  type ItemFacts = {
    route: Path
    kind: 'path' | 'webhook' | 'callback'
    key: string
    name?: string
    of?: Path
    params: Param[]
    // Whether one of its parameters is a reference that could not be
    // followed.
    open: boolean
    servers: Member | undefined
    // The names of the path's template expressions, or null where it is
    // no path or its braces are not a template's.
    template: string[] | null
    // The path parameters already said to have no expression.
    stray: Set<number>
    depth: number
  }

  const rootSeen = stand(raw, index.root, [])
  const rootLists: Record<string, Member | undefined> = {}
  for (const name of ['servers', 'security', 'consumes', 'produces', 'schemes']) rootLists[name] = member(rootSeen, name)

  // The first of the candidates that is a list, or with `filled` a list
  // that holds something.
  const pick = (cands: [From, Member | undefined, Path][], filled: boolean): Lot => {
    for (const [from, m, route] of cands) {
      if (undefined !== m && Array.isArray(m.value) && (!filled || 0 < m.value.length)) return { from, route }
    }
    return { from: filled ? 'default' : 'none', route: null }
  }

  const onPath = new Set<any>()

  const operationOf = (op: Seen | undefined, route: Path, method: string, additional: boolean, item: ItemFacts) => {
    // A reference where an operation is expected, which could not be
    // followed, is no operation that can be read.
    if (undefined === op || !isMap(op.node) || op.left) return
    const v = versionOf(op)
    const { list: all, open: mineOpen } = paramsOf(op, route, 'operation')
    const mine = all.filter((p) => !isIgnored(p))
    const open = item.open || mineOpen
    for (const p of all) {
      if (!isIgnored(p)) continue
      const row: IgnoredFacts = { route: p.route, what: 'parameter', name: p.name, kind: item.kind, method, index: p.index }
      if ('path' === item.kind) row.path = item.key
      if (additional) row.additional = true
      ignored.push(row)
    }
    const params = inherit(item.params, mine)
    const applies: Applies = { params, open }
    if (undefined !== op.loc && !byLoc.has(op.loc)) byLoc.set(op.loc, applies)

    const facts: OperationFacts = {
      route,
      kind: item.kind,
      method,
      additional,
      partial: open,
      parameters: params,
      security: pick(
        [
          ['operation', member(op, 'security'), [...route, 'security']],
          ['root', rootLists.security, ['security']],
        ],
        false,
      ),
    }
    if ('path' === item.kind) facts.path = item.key
    else facts.name = 'webhook' === item.kind ? item.key : item.name
    if ('callback' === item.kind) {
      facts.expression = item.key
      facts.of = item.of
    }
    const id = member(op, 'operationId')?.value
    if ('string' === typeof id) facts.operationId = id
    if (threeX) {
      // A list of servers that is empty is none, as the specification
      // has it for the root's.
      facts.servers = pick(
        [
          ['operation', member(op, 'servers'), [...route, 'servers']],
          ['pathItem', item.servers, [...item.route, 'servers']],
          ['root', rootLists.servers, ['servers']],
        ],
        true,
      )
    } else {
      // An operation's list stands in the root's place, an empty one too,
      // which clears it.
      for (const name of ['consumes', 'produces', 'schemes'] as const) {
        facts[name] = pick(
          [
            ['operation', member(op, name), [...route, name]],
            ['root', rootLists[name], [name]],
          ],
          false,
        )
      }
    }
    operations.push(facts)

    // Each template expression of the path names a path parameter of the
    // operation, and each path parameter an expression.
    if (null !== item.template) {
      const at = pointer(route)
      for (const name of new Set(item.template)) {
        const hit = params.find((p) => 'path' === p.in && p.name === name)
        const row: Connection = {
          kind: 'pathParameter',
          at,
          name,
          found: undefined !== hit,
          target: undefined === hit ? null : pointer(hit.route),
        }
        // It may be the parameter that a reference left as written names.
        if (undefined === hit) row.why = open ? 'unresolved' : 'no-parameter'
        say(row)
      }
      for (const p of params) {
        if ('path' !== p.in || item.template.includes(p.name)) continue
        // One of the Path Item's own is said once, not for each operation.
        if ('pathItem' === p.from) {
          if (item.stray.has(p.index)) continue
          item.stray.add(p.index)
        }
        say({ kind: 'pathParameter', at: pointer(p.route), name: p.name, found: false, target: null, why: 'no-expression' })
      }
    }

    if (!threeX) return
    if (has(v, 'parameter', 'content')) for (const p of mine) contentOf(p.seen, p.route, v)
    if (has(v, 'operation', 'requestBody')) contentOf(get(op, 'requestBody', route), [...route, 'requestBody'], v)

    const responses = get(op, 'responses', route)
    for (const code of namesIn(responses)) {
      if (!has(v, 'responses', code)) continue
      const at = [...route, 'responses', code]
      const response = get(responses, code, [...route, 'responses'])
      if (undefined === response || !isMap(response.node)) continue
      contentType(response, at, 'responseHeader')
      contentOf(response, at, v)
      const links = get(response, 'links', at)
      for (const name of namesIn(links)) linkOf(get(links, name, [...at, 'links']), [...at, 'links', name], applies)
    }

    if (!has(v, 'operation', 'callbacks')) return
    const callbacks = get(op, 'callbacks', route)
    for (const name of namesIn(callbacks)) {
      const callback = get(callbacks, name, [...route, 'callbacks'])
      if (undefined === callback || !isMap(callback.node)) continue
      for (const key of namesIn(callback)) {
        if (!has(v, 'callback', key)) continue
        const at = [...route, 'callbacks', name, key]
        // The key is a runtime expression, alone or between braces in a
        // URL, of the request this operation describes.
        try {
          for (const part of readTemplate(key, 'runtime').parts) {
            if ('name' in part && undefined !== part.expression) checkExpression(part.expression, at, applies)
          }
        } catch (err) {
          if (!(err instanceof ExpressionError)) throw err
          say({ kind: 'expression', at: pointer(at), name: key, found: false, target: null, why: 'malformed' })
        }
        itemOf(get(callback, key, [...route, 'callbacks', name]), at, {
          kind: 'callback',
          key,
          name,
          of: route,
          depth: item.depth + 1,
        })
      }
    }
  }

  const itemOf = (
    item: Seen | undefined,
    route: Path,
    ctx: { kind: 'path' | 'webhook' | 'callback'; key: string; name?: string; of?: Path; depth: number },
  ) => {
    // A route that comes back to a Path Item it is already in ends there.
    if (undefined === item || !isMap(item.node) || onPath.has(item.node)) return
    if (maxDepth <= ctx.depth) refuse('openapi_depth', 'callbacks nested deeper than ' + maxDepth, pointer(route))
    const v = versionOf(item)
    const { list: all, open } = paramsOf(item, route, 'pathItem')
    for (const p of all) {
      if (!isIgnored(p)) continue
      const row: IgnoredFacts = { route: p.route, what: 'parameter', name: p.name, kind: ctx.kind, index: p.index }
      if ('path' === ctx.kind) row.path = ctx.key
      ignored.push(row)
    }
    let template: string[] | null = null
    if ('path' === ctx.kind) {
      try {
        template = namesOf(readTemplate(ctx.key, 'path'))
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err
      }
    }
    const facts: ItemFacts = {
      route,
      kind: ctx.kind,
      key: ctx.key,
      params: all.filter((p) => !isIgnored(p)),
      open,
      servers: member(item, 'servers'),
      template,
      stray: new Set(),
      depth: ctx.depth,
    }
    if (undefined !== ctx.name) facts.name = ctx.name
    if (undefined !== ctx.of) facts.of = ctx.of
    if (threeX && has(v, 'parameter', 'content')) for (const p of facts.params) contentOf(p.seen, p.route, v)
    onPath.add(item.node)
    try {
      for (const name of namesIn(item)) {
        const state = step(v, 'pathItem', name)
        if ('data' === state) continue
        const s = slot(v, state)
        if ('operation' === s.type && 'object' === s.kind) {
          operationOf(get(item, name, route), [...route, name], name.toUpperCase(), false, facts)
        } else if ('additionalOperations' === name) {
          const more = get(item, name, route)
          if (undefined === more || !isMap(more.node)) continue
          for (const method of namesIn(more)) {
            if (!has(v, state, method)) continue
            operationOf(get(more, method, [...route, name]), [...route, name, method], method, true, facts)
          }
        }
      }
    } finally {
      onPath.delete(item.node)
    }
  }

  const paths = get(rootSeen, 'paths', [])
  if (undefined !== paths && isMap(paths.node)) {
    const v = versionOf(paths)
    for (const key of namesIn(paths)) {
      if (!has(v, 'paths', key)) continue
      itemOf(get(paths, key, ['paths']), ['paths', key], { kind: 'path', key, depth: 0 })
    }
  }
  if (has(mv, 'root', 'webhooks')) {
    const hooks = get(rootSeen, 'webhooks', [])
    if (undefined !== hooks && isMap(hooks.node)) {
      for (const name of namesIn(hooks)) {
        itemOf(get(hooks, name, ['webhooks']), ['webhooks', name], { kind: 'webhook', key: name, depth: 0 })
      }
    }
  }

  // An operation no route reaches, as it is written: one in a Path Item
  // of `components` that nothing uses, or in the paths of another
  // document.
  const written = (loc: Loc): Applies => {
    const v = loc.doc.mv
    const doc = loc.doc === home ? undefined : loc.doc.key
    // The Path Item is the operation's parent, or for a member of
    // `additionalOperations` the parent of that map.
    let holder = loc.parent
    if (undefined !== holder && 'pathItem' !== slot(v, holder.state).type) holder = holder.parent
    const isItem = undefined !== holder && 'pathItem' === slot(v, holder.state).type
    const above = isItem ? paramsOf({ node: holder!.raw, loc: holder }, pathOf(holder!), 'pathItem', doc) : { list: [], open: false }
    const mine = paramsOf({ node: loc.raw, loc }, pathOf(loc), 'operation', doc)
    return {
      params: inherit(
        above.list.filter((p) => !isIgnored(p)),
        mine.list.filter((p) => !isIgnored(p)),
      ),
      open: above.open || mine.open,
    }
  }

  // The operation a Link names, by `operationId` or by `operationRef`.
  const targetOf = (link: Seen): Applies | undefined => {
    let loc: Loc | undefined
    const id = member(link, 'operationId')?.value
    if ('string' === typeof id) loc = declared.get(id)?.[0]?.loc
    else {
      const ref = member(link, 'operationRef')?.value
      if ('string' !== typeof ref || undefined === link.loc) return undefined
      const where = index.locate(ref, link.loc.base)
      if (undefined === where.target) return undefined
      const land = index.landingAt(where.target, where.doc)
      if (!land.found || undefined === land.loc) return undefined
      if ('operation' !== slot(land.loc.doc.mv, index.stateAt(land)).type) return undefined
      loc = land.loc
    }
    if (undefined === loc) return undefined
    let applies = byLoc.get(loc)
    if (undefined === applies) byLoc.set(loc, (applies = written(loc)))
    return applies
  }

  // A Link's parameter names are held to the parameters of the operation
  // the Link names. A name may say the location first, as `path.id`, and
  // is read that way where the operation has such a parameter.
  for (const { link, route, keys, ord: first } of pending) {
    const named = targetOf(link)
    if (undefined === named) continue
    const target = named.params
    keys.forEach((key, i) => {
      const dot = key.indexOf('.')
      const where = 0 < dot ? key.slice(0, dot) : ''
      let hit = LOCATIONS.has(where) ? target.find((p) => p.in === where && sameName(p, key.slice(dot + 1))) : undefined
      let ambiguous = false
      if (undefined === hit) {
        const named = target.filter((p) => sameName(p, key))
        hit = named[0]
        ambiguous = 1 < new Set(named.map((p) => p.in)).size
      }
      const row: Connection = {
        kind: 'linkParameter',
        at: pointer([...route, 'parameters', key]),
        name: key,
        found: undefined !== hit,
        target: undefined === hit ? null : pointer(hit.route),
      }
      if (undefined !== hit?.doc) row.targetDoc = hit.doc
      if (undefined === hit && named.open) row.why = 'unresolved'
      if (ambiguous) row.ambiguous = true
      rows.push([first + i, row])
    })
  }

  return { operations, ignored, rows: rows.sort((a, b) => a[0] - b[0]).map((r) => r[1]) }
}

// The value a tree has at a route, or undefined.
function valueAt(tree: any, route: Path): any {
  let node = tree
  for (const seg of route) {
    node = stepInto(node, seg)
    if (NOTHING === node) return undefined
  }
  return node
}

// The rows as the caller gets them: each place as a pointer, and each
// value as the resolved tree has it there.
function ignoredRows(found: Found): Ignored[] {
  return found.ignored.map(({ route, ...rest }) => ({ at: pointer(route), ...rest }))
}

function operationViews(found: Found, tree: any): OperationView[] {
  const lot = (l: Lot): Inherited => {
    if (null === l.route) return { from: l.from, at: null, value: 'default' === l.from ? [{ url: '/' }] : [] }
    const value = valueAt(tree, l.route)
    return { from: l.from, at: pointer(l.route), value: Array.isArray(value) ? value : [] }
  }
  return found.operations.map((f) => {
    const view: OperationView = { at: pointer(f.route), kind: f.kind, method: f.method } as OperationView
    if (undefined !== f.path) view.path = f.path
    if (undefined !== f.name) view.name = f.name
    if (undefined !== f.expression) view.expression = f.expression
    if (undefined !== f.of) view.of = pointer(f.of)
    if (f.additional) view.additional = true
    if (f.partial) view.partial = true
    if (undefined !== f.operationId) view.operationId = f.operationId
    view.operation = valueAt(tree, f.route)
    view.parameters = f.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      at: pointer(p.route),
      from: p.from,
      parameter: valueAt(tree, p.route),
    }))
    if (undefined !== f.servers) view.servers = lot(f.servers)
    view.security = lot(f.security)
    if (undefined !== f.consumes) view.consumes = lot(f.consumes)
    if (undefined !== f.produces) view.produces = lot(f.produces)
    if (undefined !== f.schemes) view.schemes = lot(f.schemes)
    return view
  })
}

export { ignoredRows, operationViews, operationsOf }

export type { From, Ignored, Inherited, OperationView, ParameterView }
