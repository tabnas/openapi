/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// URI references (RFC 3986) and JSON Pointers (RFC 6901), as the resolver
// and the connections report read them. Nothing here knows OpenAPI.

// A location, as segments from a document's root.
type Path = (string | number)[]

// RFC 6901: a pointer from path segments.
function pointer(path: readonly (string | number)[]): string {
  let out = ''
  for (const seg of path) out += '/' + String(seg).replace(/~/g, '~0').replace(/\//g, '~1')
  return out
}

// A URI fragment as JSON Pointer segments: percent-decoded whole first,
// then split, then `~1` and `~0` (RFC 6901 section 6). Null when it is not
// a well-formed pointer: bad percent-encoding, or a `~` not followed by 0
// or 1.
function pointerParts(fragment: string): string[] | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    return null
  }
  if ('' === decoded) return []
  if (!decoded.startsWith('/')) return null
  const parts = decoded.slice(1).split('/')
  if (parts.some((p) => /~(?![01])/.test(p))) return null
  return parts.map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
}

// A plain-name fragment, as JSON Schema 2020-12 defines an anchor.
const ANCHOR = /^[A-Za-z_][-A-Za-z0-9._]*$/

// RFC 3986 section 5.2: reference resolution against a base URI.
type Uri = {
  scheme?: string
  authority?: string
  path: string
  query?: string
  fragment?: string
}

function parseUri(u: string): Uri {
  const m = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(u)!
  return { scheme: m[1], authority: m[2], path: m[3], query: m[4], fragment: m[5] }
}

function removeDots(input: string): string {
  let out = ''
  while (0 < input.length) {
    if (input.startsWith('../')) input = input.slice(3)
    else if (input.startsWith('./')) input = input.slice(2)
    else if (input.startsWith('/./')) input = input.slice(2)
    else if ('/.' === input) input = '/'
    else if (input.startsWith('/../') || '/..' === input) {
      input = '/' + input.slice(4)
      out = out.slice(0, Math.max(0, out.lastIndexOf('/')))
    } else if ('.' === input || '..' === input) input = ''
    else {
      const seg = /^\/?[^/]*/.exec(input)![0]
      out += seg
      input = input.slice(seg.length)
    }
  }
  return out
}

function resolveUri(base: string, ref: string): string {
  const r = parseUri(ref)
  const b = parseUri(base)
  const t: Uri = { path: '' }
  if (undefined !== r.scheme) {
    t.scheme = r.scheme
    t.authority = r.authority
    t.path = removeDots(r.path)
    t.query = r.query
  } else {
    if (undefined !== r.authority) {
      t.authority = r.authority
      t.path = removeDots(r.path)
      t.query = r.query
    } else {
      if ('' === r.path) {
        t.path = b.path
        t.query = undefined !== r.query ? r.query : b.query
      } else {
        const merged = r.path.startsWith('/')
          ? r.path
          : undefined !== b.authority && '' === b.path
            ? '/' + r.path
            : b.path.slice(0, b.path.lastIndexOf('/') + 1) + r.path
        t.path = removeDots(merged)
        t.query = r.query
      }
      t.authority = b.authority
    }
    t.scheme = b.scheme
  }
  t.fragment = r.fragment
  return (
    (undefined !== t.scheme ? t.scheme + ':' : '') +
    (undefined !== t.authority ? '//' + t.authority : '') +
    t.path +
    (undefined !== t.query ? '?' + t.query : '') +
    (undefined !== t.fragment ? '#' + t.fragment : '')
  )
}

const withoutFragment = (u: string) => u.replace(/#.*$/s, '')

function fragmentOf(u: string): string | undefined {
  const i = u.indexOf('#')
  return -1 === i ? undefined : u.slice(i + 1)
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

// A plain map: the grammar's null-prototype maps, and JSON.parse's.
function isMap(value: unknown): value is Record<string, any> {
  if (null == value || 'object' !== typeof value || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return null === proto || Object.prototype === proto
}

// One step into a value: an own member of a map, or an RFC 6901 index of
// a list (`0`, or digits with no leading zero, in range). NOTHING when the
// step names nothing.
const NOTHING: unique symbol = Symbol('nothing')
const INDEX = /^(?:0|[1-9][0-9]*)$/

function stepInto(node: any, seg: string | number): any {
  if (Array.isArray(node)) {
    const i = 'number' === typeof seg ? seg : INDEX.test(seg) ? Number(seg) : -1
    return Number.isInteger(i) && 0 <= i && i < node.length ? node[i] : NOTHING
  }
  return isMap(node) && own(node, String(seg)) ? node[seg as string] : NOTHING
}

// A new map without a prototype, with the members of each given map in
// turn: defined, never assigned, so a member named `__proto__` is data.
function merged(...maps: Record<string, any>[]): Record<string, any> {
  const out = Object.create(null)
  for (const m of maps) for (const k of Object.keys(m)) define(out, k, m[k])
  return out
}

function define(o: any, k: string, v: any): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

export {
  ANCHOR,
  NOTHING,
  define,
  fragmentOf,
  isMap,
  merged,
  own,
  pointer,
  pointerParts,
  resolveUri,
  stepInto,
  withoutFragment,
}

export type { Path }
