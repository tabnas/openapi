/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/graph.cjs: comparing two resolved trees as graphs.
//
// A resolved tree may be a cyclic graph, and which maps are one shared
// object matters to apidef, so three comparisons are made, each weaker
// than the one before:
//
// - `graphDiff`: the graphs walked together, depth first in member order,
//   each map and list numbered at its first visit, a later visit of the
//   same object read as a back-reference to its number. Equal when no
//   step differs: members, member order, values, and which objects are
//   shared. Returns the first step that differs, or null.
// - `cutHash`: the tree as JSON, with a cycle cut where it closes (an
//   object met again on the path from the root is written as a mark
//   saying how many levels up it is). Sharing that is not a cycle is
//   written out at each place. Equal hashes mean the same content and
//   member order, whatever is shared. With `sorted`, member order is
//   ignored too. The JSON can be far larger than the graph, so it has a
//   budget of nodes, past which the answer is null (unknown).
// - `Bisim`: the two graphs unfolded without end, compared by walking
//   pairs of nodes; the same content and member order, whatever is
//   shared and wherever a cycle closes. Linear in the pairs met, so it
//   has no budget; used where the cut JSON is too large, and for each
//   site.
//
// Prototypes are ignored throughout: a map is any object that is not a
// list.

const Crypto = require('node:crypto')

const isObj = (v) => null != v && 'object' === typeof v
const kindOf = (v) => (Array.isArray(v) ? 'list' : isObj(v) ? 'map' : null === v ? 'null' : typeof v)
const keysOf = (v) => (Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v))
// RFC 6901: the root is ''.
const ptr = (path) => path.map((p) => '/' + String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('')
const show = (v) => {
  if (Array.isArray(v)) return `[list of ${v.length}]`
  if (isObj(v)) {
    const k = Object.keys(v)
    return `{map: ${k.slice(0, 8).map((x) => JSON.stringify(x)).join(', ')}${8 < k.length ? ', ...' : ''}}`
  }
  if (undefined === v) return '(absent)'
  const s = JSON.stringify(v)
  return 80 < s.length ? s.slice(0, 77) + '...' : s
}

// The first step where two graphs differ, or null when they are equal as
// graphs. { path, what, a, b }.
function graphDiff(ra, rb) {
  const ida = new Map()
  const idb = new Map()
  let n = 0
  const stack = [[ra, rb, []]]
  while (0 < stack.length) {
    const [a, b, path] = stack.pop()
    const ka = kindOf(a)
    const kb = kindOf(b)
    if (ka !== kb) return { path: ptr(path), what: 'kind', a: show(a), b: show(b) }
    if (!isObj(a)) {
      if (!Object.is(a, b) && !(a === b)) return { path: ptr(path), what: 'value', a: show(a), b: show(b) }
      continue
    }
    const sa = ida.get(a)
    const sb = idb.get(b)
    if (undefined !== sa || undefined !== sb) {
      if (sa !== sb) {
        return {
          path: ptr(path), what: 'sharing',
          a: undefined === sa ? 'a new object' : `the object first met as #${sa}`,
          b: undefined === sb ? 'a new object' : `the object first met as #${sb}`,
        }
      }
      continue
    }
    ida.set(a, n)
    idb.set(b, n)
    n++
    const kA = keysOf(a)
    const kB = keysOf(b)
    if (kA.length !== kB.length || kA.some((k, i) => k !== kB[i])) {
      return { path: ptr(path), what: 'members', a: kA.join(', '), b: kB.join(', ') }
    }
    for (let i = kA.length - 1; 0 <= i; i--) stack.push([a[kA[i]], b[kA[i]], [...path, kA[i]]])
  }
  return null
}

// The graph's canonical form as a hash: equal hashes, equal graphs.
function graphHash(root) {
  const h = Crypto.createHash('sha1')
  const id = new Map()
  const stack = [root]
  while (0 < stack.length) {
    const v = stack.pop()
    if (!isObj(v)) {
      h.update('s' + JSON.stringify(v ?? null) + '\0')
      continue
    }
    if (id.has(v)) {
      h.update('r' + id.get(v) + '\0')
      continue
    }
    id.set(v, id.size)
    const ks = keysOf(v)
    h.update((Array.isArray(v) ? 'l' : 'm') + ks.length + '\0')
    for (let i = ks.length - 1; 0 <= i; i--) stack.push(v[ks[i]])
    for (const k of ks) h.update('k' + String(k) + '\0')
  }
  return h.digest('hex')
}

// The cut JSON as a hash, or null past `budget` nodes.
function cutHash(root, { sorted = false, budget = 2e7 } = {}) {
  const h = Crypto.createHash('sha1')
  const onPath = new Map()
  let nodes = 0
  // Frames: [value, depth] to enter, or ['exit', value] to leave.
  const stack = [[root, 0]]
  const EXIT = Symbol('exit')
  while (0 < stack.length) {
    const f = stack.pop()
    if (EXIT === f[0]) {
      onPath.delete(f[1])
      continue
    }
    const [v, depth] = f
    if (++nodes > budget) return null
    if (!isObj(v)) {
      h.update('s' + JSON.stringify(v ?? null) + '\0')
      continue
    }
    if (onPath.has(v)) {
      h.update('c' + (depth - onPath.get(v)) + '\0')
      continue
    }
    onPath.set(v, depth)
    let ks = keysOf(v)
    if (sorted && !Array.isArray(v)) ks = ks.slice().sort()
    h.update((Array.isArray(v) ? 'l' : 'm') + ks.length + '\0')
    for (const k of ks) h.update('k' + String(k) + '\0')
    stack.push([EXIT, v])
    for (let i = ks.length - 1; 0 <= i; i--) stack.push([v[ks[i]], depth + 1])
  }
  return h.digest('hex')
}

// Pairwise unfolding equality, with what earlier calls proved kept.
class Bisim {
  constructor() {
    this.eq = new WeakMap()
    this.neq = new WeakMap()
  }
  has(m, a, b) {
    const s = m.get(a)
    return undefined !== s && s.has(b)
  }
  add(m, a, b) {
    let s = m.get(a)
    if (undefined === s) m.set(a, (s = new WeakSet()))
    s.add(b)
  }
  // The same scalar, or two objects of one kind with the same keys in order.
  static shallow(a, b) {
    const ka = kindOf(a)
    if (ka !== kindOf(b)) return false
    if (!isObj(a)) return Object.is(a, b) || a === b
    const kA = keysOf(a)
    const kB = keysOf(b)
    return kA.length === kB.length && kA.every((k, i) => k === kB[i])
  }
  equal(a, b) {
    if (!isObj(a) || !isObj(b)) return Bisim.shallow(a, b)
    if (this.has(this.eq, a, b)) return true
    if (this.has(this.neq, a, b)) return false
    const seen = new WeakMap()
    const pairs = []
    const visit = (x, y) => {
      let s = seen.get(x)
      if (undefined === s) seen.set(x, (s = new WeakSet()))
      if (s.has(y)) return false
      s.add(y)
      pairs.push([x, y])
      return true
    }
    visit(a, b)
    const stack = [[a, b]]
    while (0 < stack.length) {
      const [x, y] = stack.pop()
      if (!Bisim.shallow(x, y)) {
        this.add(this.neq, a, b)
        this.add(this.neq, x, y)
        return false
      }
      for (const k of keysOf(x)) {
        const cx = x[k]
        const cy = y[k]
        if (isObj(cx) && isObj(cy)) {
          if (this.has(this.eq, cx, cy)) continue
          if (this.has(this.neq, cx, cy)) {
            this.add(this.neq, a, b)
            return false
          }
          if (visit(cx, cy)) stack.push([cx, cy])
        } else if (!Bisim.shallow(cx, cy)) {
          this.add(this.neq, a, b)
          this.add(this.neq, x, y)
          return false
        }
      }
    }
    for (const [x, y] of pairs) this.add(this.eq, x, y)
    return true
  }
}

// The value at a path, or undefined.
function at(root, path) {
  let v = root
  for (const p of path) {
    if (!isObj(v) || !Object.prototype.hasOwnProperty.call(v, p)) return undefined
    v = v[p]
  }
  return v
}

module.exports = { graphDiff, graphHash, cutHash, Bisim, at, ptr, show, isObj, kindOf, keysOf }
