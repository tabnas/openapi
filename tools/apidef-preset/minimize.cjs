/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/minimize.cjs: the smallest document that still
// shows a class of difference.
//
// Delta debugging on the tree, not the lines: for each map and list, top
// down, it tries removing members in chunks (half of them, then quarters,
// down to one at a time), keeps every removal after which the predicate
// still holds, and goes round again until a whole pass removes nothing.
// Then it tries shortening each string member value (a description, say)
// to one character. The result is JSON text.
//
// A member named `__proto__` is kept as a member: the tree is read with
// JSON.parse, which defines it, and every copy is made through JSON text.
//
// A module for apidef-preset.cjs; it runs nothing by itself.

const isObj = (v) => null != v && 'object' === typeof v

function containers(root) {
  const out = []
  const stack = [[root, []]]
  while (0 < stack.length) {
    const [v, path] = stack.shift()
    if (!isObj(v)) continue
    out.push(path)
    const ks = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v)
    for (const k of ks) stack.push([v[k], [...path, k]])
  }
  return out
}

const at = (root, path) => path.reduce((v, k) => (isObj(v) ? v[k] : undefined), root)

// `tree` without the members `drop` of the container at `path`.
function without(tree, path, drop) {
  const copy = JSON.parse(JSON.stringify(tree))
  const node = at(copy, path)
  if (Array.isArray(node)) {
    const set = new Set(drop)
    const kept = node.filter((_, i) => !set.has(i))
    node.length = 0
    node.push(...kept)
  } else {
    for (const k of drop) delete node[k]
  }
  return copy
}

// `holds(text)` is the predicate. `deadline` a time in ms; `tick(info)` is
// called after each candidate.
function minimize(text, holds, { deadline = Infinity, tick = () => {} } = {}) {
  let tree = JSON.parse(text)
  let best = JSON.stringify(tree)
  if (!holds(best)) return { text: best, held: false, tries: 1 }
  let tries = 1
  const attempt = (cand) => {
    tries++
    const t = JSON.stringify(cand)
    const ok = t.length < best.length && holds(t)
    tick({ tries, bytes: best.length })
    if (ok) {
      tree = cand
      best = t
    }
    return ok
  }
  let changed = true
  while (changed && Date.now() < deadline) {
    changed = false
    for (const path of containers(tree)) {
      if (Date.now() >= deadline) break
      const node = at(tree, path)
      if (!isObj(node)) continue
      let keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node)
      let size = Math.max(1, Math.ceil(keys.length / 2))
      while (0 < keys.length && Date.now() < deadline) {
        let removed = false
        for (let i = 0; i < keys.length; i += size) {
          const drop = keys.slice(i, i + size)
          if (attempt(without(tree, path, drop))) {
            removed = true
            changed = true
            const n = at(tree, path)
            keys = Array.isArray(n) ? n.map((_, j) => j) : Object.keys(n)
            break
          }
        }
        if (!removed) {
          if (1 === size) break
          size = Math.max(1, Math.floor(size / 2))
        }
      }
    }
  }
  // Shorter strings, where any string will do.
  for (const path of containers(tree)) {
    if (Date.now() >= deadline) break
    const node = at(tree, path)
    if (!isObj(node) || Array.isArray(node)) continue
    for (const k of Object.keys(node)) {
      const v = node[k]
      if ('string' !== typeof v || 1 >= v.length || '$ref' === k) continue
      const cand = JSON.parse(JSON.stringify(tree))
      at(cand, path)[k] = v[0]
      attempt(cand)
    }
  }
  return { text: best, held: true, tries }
}

module.exports = { minimize }
