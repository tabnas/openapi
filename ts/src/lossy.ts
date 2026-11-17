/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The numbers a document wrote that a JavaScript number does not hold
// exactly, and where each one is.
//
// The tree keeps the plain number: a tree with a type of its own for a
// large integer would break every tool that reads one. `parse` lists what
// was lost instead, when it is asked to, each with the text as written.
// On the grammar's path the numbers are gathered as the grammar closes
// each one (`lossyOf` in openapi.ts). On the fast path there is no
// grammar, and `lossyInJson` finds them by a pass over the JSON text.

import { pointer } from './uri'

// A number the document wrote that the tree does not hold exactly: an
// integer written out in full that the number read is not equal to, such
// as one past 2^53, or a number too large to be read at all.
type Lossy = {
  // The number as the document wrote it.
  text: string
  // The number the tree holds in its place.
  value: number
  // Where it is written: the offset into the text, from 0, and the row
  // and column, from 1, all counted as JavaScript counts a string.
  pos: number
  row: number
  col: number
  // Where it is in the tree, as an RFC 6901 pointer, when the tree holds
  // it there.
  at?: string
}

// A number that lost precision, as the parse finds it: where its text
// starts, and the members and indexes that lead to it, where the rules it
// sits under say them.
type LossyFound = { text: string; value: number; pos: number; path?: string[] }

// An integer the document wrote out in full, by its base: decimal, and
// the prefixed forms either reading takes. `_` is the base reading's
// separator.
const INTEGER = /^([-+]?)(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*)$/
// A number written with digits, as against a word for a value that is
// not finite.
const WRITTEN = /^[-+]?(?:[0-9]|\.[0-9])/

// Whether the number read is not the number the document wrote: an
// integer written out in full that the number is not equal to, or a
// number written with digits that is too large to be read at all.
function isLossy(text: string, value: number): boolean {
  if (!Number.isFinite(value)) return WRITTEN.test(text)
  // The shortest integer that a double cannot hold has sixteen digits.
  if (text.length < 16) return false
  const m = INTEGER.exec(text)
  if (null == m || !Number.isInteger(value)) return false
  let exact: bigint
  try {
    const body = m[2].replace(/_/g, '')
    // A leading zero is decimal to both readings, where BigInt reads
    // nothing special in it either.
    exact = BigInt(/^0[xXoObB]/.test(body) ? body.toLowerCase() : body)
  } catch {
    return false
  }
  if ('-' === m[1]) exact = -exact
  return exact !== BigInt(value)
}

// The lossy numbers of JSON text that `JSON.parse` has read, in the order
// they are written, each with the members and indexes that lead to it.
// One pass over the text, which is known to be JSON: a string, a number,
// and the six marks are all it has to tell apart. A place costs a step
// for each container the number is in, and `placing` is how many steps
// the pass may spend: past that, a number is listed without its place.
function lossyInJson(text: string, placing: number): LossyFound[] {
  const found: LossyFound[] = []
  // The containers open at the cursor. A list has the index of the item
  // being read. A map has where the name of the member being read is
  // written, which is read out only when a number under it is lossy.
  const lists: boolean[] = []
  const index: number[] = []
  const nameFrom: number[] = []
  const nameTo: number[] = []
  // The next string is a member's name.
  let name = false
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (0x22 === c) {
      const from = i++
      while (i < n) {
        const d = text.charCodeAt(i)
        if (0x5c === d) i += 2
        else if (0x22 === d) break
        else i++
      }
      i++
      if (name) {
        nameFrom[nameFrom.length - 1] = from
        nameTo[nameTo.length - 1] = i
        name = false
      }
    } else if (0x7b === c || 0x5b === c) {
      lists.push(0x5b === c)
      index.push(0)
      nameFrom.push(-1)
      nameTo.push(-1)
      name = 0x7b === c
      i++
    } else if (0x7d === c || 0x5d === c) {
      lists.pop()
      index.pop()
      nameFrom.pop()
      nameTo.pop()
      name = false
      i++
    } else if (0x2c === c) {
      const top = lists.length - 1
      if (lists[top]) index[top]++
      else name = true
      i++
    } else if (0x2d === c || (0x30 <= c && c <= 0x39)) {
      const from = i++
      while (i < n) {
        const d = text.charCodeAt(i)
        if ((0x30 <= d && d <= 0x39) || 0x2e === d || 0x65 === d || 0x45 === d || 0x2b === d || 0x2d === d) i++
        else break
      }
      // The shortest number that can be lossy is one too large to read,
      // such as 1e309.
      if (i - from < 5) continue
      const written = text.slice(from, i)
      const value = Number(written)
      if (!isLossy(written, value)) continue
      let path: string[] | undefined
      if (lists.length <= placing) {
        placing -= lists.length
        path = []
        for (let d = 0; d < lists.length; d++) {
          path.push(lists[d] ? String(index[d]) : JSON.parse(text.slice(nameFrom[d], nameTo[d])))
        }
      } else {
        placing = 0
      }
      found.push({ text: written, value, pos: from, path })
    } else {
      // White space, a colon, or a letter of true, false or null.
      i++
    }
  }
  return found
}

// The numbers a parse found lossy, each with its place in the tree where
// the tree holds it there. A place the rules gave is said only when the
// finished tree has that very number at it: a repeated member name keeps
// one of its values, and the other is in no place.
function located(found: LossyFound[], tree: any, text: string): Lossy[] {
  // Rows and columns, counted once along the text. The numbers come in
  // the order they were read, which is the order they are written in.
  let at = 0
  let row = 1
  let lineStart = 0
  const place = (pos: number) => {
    if (pos < at) {
      at = 0
      row = 1
      lineStart = 0
    }
    for (; at < pos; at++) {
      const c = text.charCodeAt(at)
      // A line ends at a line feed, or at a carriage return with none after it.
      if (0x0a === c || (0x0d === c && 0x0a !== text.charCodeAt(at + 1))) {
        row++
        lineStart = at + 1
      }
    }
    return { row, col: pos - lineStart + 1 }
  }
  return found.map(({ path, ...rest }) => {
    const entry: Lossy = { ...rest, ...place(rest.pos) }
    if (undefined === path) return entry
    let node = tree
    for (const part of path) {
      if (null == node || 'object' !== typeof node || !Object.prototype.hasOwnProperty.call(node, part)) {
        return entry
      }
      node = node[part]
    }
    return Object.is(node, entry.value) ? { ...entry, at: pointer(path) } : entry
  })
}

export { isLossy, located, lossyInJson }
export type { Lossy, LossyFound }
