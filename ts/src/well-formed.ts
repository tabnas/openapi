/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// A tree with every lone surrogate read as U+FFFD.
//
// A JSON or YAML escape can spell half of a surrogate pair, `"\ud800"`,
// and a JavaScript string holds it as it is. Nothing that writes UTF-8
// can write it: every encoder puts U+FFFD, the replacement character, in
// its place. So a tree that is to be written out, hashed, or compared
// with one read from bytes needs the same done to it first. Raw mode
// never rewrites a value the grammar returned, so this is a function of
// its own, applied to the tree `parse` gives.

import { Tabnas } from '@tabnas/parser'

type WellFormedOptions = {
  // What two member names give when the repair makes them one name:
  // the later value ('last', the default), or the two merged as `parse`
  // merges a repeated name under `duplicates: 'merge'`.
  duplicates?: 'last' | 'merge'
}

const isWellFormed = (s: string): boolean => (s as any).isWellFormed()
const toWellFormed = (s: string): string => (s as any).toWellFormed()

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

function define(o: object, k: string | number, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

// Whether any string or member name of the tree has a lone surrogate.
function needsRepair(tree: unknown): boolean {
  if ('string' === typeof tree) return !isWellFormed(tree)
  if (null == tree || 'object' !== typeof tree) return false
  const seen = new Set<object>([tree])
  const stack: object[] = [tree]
  while (0 < stack.length) {
    const node: any = stack.pop()
    const list = Array.isArray(node)
    const names = list ? null : Object.keys(node)
    const n = list ? node.length : names!.length
    for (let i = 0; i < n; i++) {
      const name = list ? i : names![i]
      if (!list && !isWellFormed(name as string)) return true
      const child = node[name]
      if ('string' === typeof child) {
        if (!isWellFormed(child)) return true
      } else if (null != child && 'object' === typeof child && !seen.has(child)) {
        seen.add(child)
        stack.push(child)
      }
    }
  }
  return false
}

// Two values under one name, merged as the base grammars merge them: the
// engine's `deep`, with every map of the result rebuilt without a
// prototype, as `parse` builds its maps.
function merged(prev: any, curr: any): any {
  const out = Tabnas.util.deep(prev, curr)
  const rebuild = (root: any): any => {
    const copy = (map: Record<string, any>) => {
      const o: Record<string, any> = Object.create(null)
      for (const name of Object.keys(map)) o[name] = map[name]
      return o
    }
    const top = Array.isArray(root) ? root : copy(root)
    const stack: any[] = [top]
    while (0 < stack.length) {
      const node = stack.pop()
      const names: (string | number)[] = Array.isArray(node) ? node.map((_: unknown, i: number) => i) : Object.keys(node)
      for (const name of names) {
        const item = node[name]
        if (null != item && 'object' === typeof item) {
          node[name] = Array.isArray(item) ? item : copy(item)
          stack.push(node[name])
        }
      }
    }
    return top
  }
  return null != out && 'object' === typeof out ? rebuild(out) : out
}

// The tree with every lone surrogate, in a string or in a member name,
// read as U+FFFD. A tree that has none comes back as it is, the same
// object. Otherwise the result is a new tree and the one given is not
// changed: each map and list is copied once, so what was shared stays
// shared and a cycle stays a cycle, and each map keeps its prototype.
function wellFormed<T>(tree: T, options: WellFormedOptions = {}): T {
  const duplicates = options.duplicates ?? 'last'
  if ('last' !== duplicates && 'merge' !== duplicates) {
    throw new TypeError('wellFormed: duplicates must be last or merge, not ' + JSON.stringify(duplicates))
  }
  if (!needsRepair(tree)) return tree
  if ('string' === typeof tree) return toWellFormed(tree) as unknown as T

  // Each node's copy, complete or not, and the copies still being filled.
  const copies = new Map<object, any>()
  const open = new Set<object>()
  type Frame = { node: any; copy: any; names: string[] | null; n: number; i: number }
  const enter = (node: any): Frame => {
    const list = Array.isArray(node)
    const copy = list ? new Array(node.length) : Object.create(Object.getPrototypeOf(node))
    const names = list ? null : Object.keys(node)
    copies.set(node, copy)
    open.add(copy)
    return { node, copy, names, n: list ? node.length : names!.length, i: 0 }
  }

  const put = (f: Frame, name: string | number, value: any): void => {
    if (null === f.names) {
      f.copy[name] = value
      return
    }
    const key = toWellFormed(name as string)
    if (own(f.copy, key)) {
      // The repair has made two names one. A value still being filled is
      // an ancestor, which cannot be merged into.
      const prev = f.copy[key]
      const mergeable = 'merge' === duplicates && null != prev && !open.has(prev) && !open.has(value)
      define(f.copy, key, mergeable ? merged(prev, value) : value)
    } else {
      define(f.copy, key, value)
    }
  }

  // Depth first, a member set only once its value is complete, so that a
  // merge sees whole values. No recursion: a deep tree cannot exhaust the
  // stack here.
  const stack: Frame[] = [enter(tree)]
  while (0 < stack.length) {
    const f = stack[stack.length - 1]
    if (f.i === f.n) {
      open.delete(f.copy)
      stack.pop()
      continue
    }
    const name = null === f.names ? f.i : f.names[f.i]
    const child = f.node[name]
    let value: any
    if ('string' === typeof child) {
      value = toWellFormed(child)
    } else if (null == child || 'object' !== typeof child) {
      value = child
    } else if (copies.has(child)) {
      // Met before: shared, or an ancestor that closes a cycle.
      value = copies.get(child)
    } else {
      // Its copy first. This member is come back to when that is done.
      stack.push(enter(child))
      continue
    }
    put(f, name, value)
    f.i++
  }
  return copies.get(tree as unknown as object)
}

export { wellFormed }
export type { WellFormedOptions }
