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

// Whether an error is the stack running out. A pattern that is compiled
// in the last frames says so as a syntax error of its own.
function ranOut(err: unknown): boolean {
  return (
    (err instanceof RangeError || err instanceof SyntaxError) && /call stack|stack overflow/i.test(String(err.message))
  )
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

// A plain-name fragment in any dialect this package reads: the anchor of
// 2020-12, and the names of 2019-09 and of draft-04 to draft-07, which
// may also hold a colon.
const PLAIN_NAME = /^[A-Za-z_][-A-Za-z0-9._:]*$/

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

// The port a scheme uses when a URI names none.
const DEFAULT_PORT: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443', ftp: '21' }

// RFC 3986 section 6.2.2.2: a percent-encoded unreserved character
// (a letter, a digit, `-`, `.`, `_` or `~`) is that character, and the hex
// digits of any other percent-encoding are upper case.
function normalizeEncoding(part: string): string {
  if (!part.includes('%')) return part
  return part.replace(/%([0-9A-Fa-f]{2})/g, (_all, hex: string) => {
    const c = parseInt(hex, 16)
    const unreserved =
      (0x41 <= c && c <= 0x5a) ||
      (0x61 <= c && c <= 0x7a) ||
      (0x30 <= c && c <= 0x39) ||
      0x2d === c ||
      0x2e === c ||
      0x5f === c ||
      0x7e === c
    return unreserved ? String.fromCharCode(c) : '%' + hex.toUpperCase()
  })
}

// RFC 3986 section 6.2: the one form that equivalent URIs share, so that
// two of them compare equal as strings. By syntax (6.2.2): the scheme and
// the host in lower case, percent-encodings as `normalizeEncoding` has
// them, and the dot segments gone from a path that starts at the root.
// By scheme (6.2.3): no empty port and no port that is the scheme's own,
// and `/` for an empty path beside an authority. The case of a path, a
// query and a fragment is theirs, and is kept.
function normalizeUri(u: string): string {
  const p = parseUri(u)
  const scheme = undefined === p.scheme ? undefined : p.scheme.toLowerCase()
  let out = undefined === scheme ? '' : scheme + ':'
  let path = normalizeEncoding(p.path)
  if (undefined !== p.authority) {
    const at = p.authority.lastIndexOf('@')
    let host = p.authority.slice(at + 1)
    let port = ''
    const m = /:([0-9]*)$/.exec(host)
    if (null !== m) {
      port = m[1]
      host = host.slice(0, m.index)
    }
    out +=
      '//' +
      normalizeEncoding(p.authority.slice(0, at + 1)) +
      normalizeEncoding(normalizeEncoding(host).toLowerCase()) +
      ('' === port || port === DEFAULT_PORT[scheme ?? ''] ? '' : ':' + port)
    path = '' === path ? '/' : removeDots(path)
  } else if (path.startsWith('/')) path = removeDots(path)
  out += path
  if (undefined !== p.query) out += '?' + normalizeEncoding(p.query)
  if (undefined !== p.fragment) out += '#' + normalizeEncoding(p.fragment)
  return out
}

// Whether a relative reference can be read against a URI: it has a
// scheme, and an authority or a path that starts at a root (RFC 3986
// section 1.2.3). A `urn:` cannot be, and so neither can the base a
// description is read under when nobody says where it is.
function hierarchical(u: string): boolean {
  const p = parseUri(u)
  return undefined !== p.scheme && (undefined !== p.authority || p.path.startsWith('/'))
}

const withoutFragment = (u: string) => u.replace(/#.*$/s, '')

// The reference that names `target` when it is read against `base`: a
// relative one, where the two have one scheme and one authority and the
// base can have a relative reference read against it, and else `target`
// as it is. What it gives always resolves to `target`.
function relativeTo(base: string, target: string): string {
  const b = parseUri(base)
  const t = parseUri(target)
  if (!hierarchical(base) || undefined === t.scheme || b.scheme !== t.scheme || b.authority !== t.authority) return target
  let rel: string
  if (b.path === t.path && b.query === t.query && undefined !== t.fragment) rel = ''
  else {
    const from = b.path.split('/')
    from.pop()
    const to = t.path.split('/')
    const name = to.pop()!
    let i = 0
    while (i < from.length && i < to.length && from[i] === to[i]) i++
    rel = '../'.repeat(from.length - i) + to.slice(i).map((seg) => seg + '/').join('') + name
    // A first segment with a colon would be read as a scheme, an empty
    // one as an authority or a root, and no path at all as the base.
    if ('' === rel || rel.startsWith('/') || /^[^/]*:/.test(rel)) rel = './' + rel
    if (undefined !== t.query) rel += '?' + t.query
  }
  if (undefined !== t.fragment) rel += '#' + t.fragment
  return resolveUri(base, rel) === target ? rel : target
}

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
  PLAIN_NAME,
  define,
  fragmentOf,
  hierarchical,
  isMap,
  merged,
  normalizeEncoding,
  normalizeUri,
  own,
  pointer,
  pointerParts,
  ranOut,
  relativeTo,
  resolveUri,
  stepInto,
  withoutFragment,
}

export type { Path }
