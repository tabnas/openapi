/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The text of a description, before any grammar reads it: its bytes
// decoded, its size, and whether it holds anything. Each of these is one
// pass over the text, whatever the text is: `parse` runs them on input
// from outside a system.

// Whether some line of the text holds anything but white space and a
// YAML comment. It is apidef's test for an empty source, which it makes
// with the one pattern `^\s*[^#\s]` under the `m` flag. That pattern
// takes time that grows with the square of a run of blank lines, since
// each line start reads the whole run again, so the same test is made
// here in a single pass: white space is passed over, then a comment to
// the end of its line, and the first thing that is neither is content.
const SPACES = /\s+/y
const COMMENT = /#[^\n\r\u2028\u2029]*/y
function hasContent(text: string): boolean {
  let i = 0
  while (i < text.length) {
    SPACES.lastIndex = i
    if (SPACES.test(text)) i = SPACES.lastIndex
    if (text.length <= i) return false
    COMMENT.lastIndex = i
    if (!COMMENT.test(text)) return true
    i = COMMENT.lastIndex
  }
  return false
}

// The length of a string in bytes of UTF-8.
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (0xd800 <= c && c < 0xdc00 && i + 1 < s.length && 0xdc00 <= s.charCodeAt(i + 1) && s.charCodeAt(i + 1) < 0xe000) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

// The text of a description given as bytes: in the encoding its
// byte-order mark names, as YAML has them, and UTF-8 without one. A
// sequence the encoding does not allow is read as U+FFFD, and the result
// says so. `skipped` is the length of the mark.
function decode(b: Uint8Array): { text: string; encoding: string; skipped: number; illFormed: boolean } {
  // The UTF-32 marks first: the little-endian one starts as UTF-16's does.
  if (4 <= b.length && 0x00 === b[0] && 0x00 === b[1] && 0xfe === b[2] && 0xff === b[3]) {
    return { ...units(b, 4, 4, true), encoding: 'utf-32be', skipped: 4 }
  }
  if (4 <= b.length && 0xff === b[0] && 0xfe === b[1] && 0x00 === b[2] && 0x00 === b[3]) {
    return { ...units(b, 4, 4, false), encoding: 'utf-32le', skipped: 4 }
  }
  if (2 <= b.length && 0xfe === b[0] && 0xff === b[1]) {
    return { ...units(b, 2, 2, true), encoding: 'utf-16be', skipped: 2 }
  }
  if (2 <= b.length && 0xff === b[0] && 0xfe === b[1]) {
    return { ...units(b, 2, 2, false), encoding: 'utf-16le', skipped: 2 }
  }
  const skipped = 3 <= b.length && 0xef === b[0] && 0xbb === b[1] && 0xbf === b[2] ? 3 : 0
  const body = 0 === skipped ? b : b.subarray(skipped)
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), encoding: 'utf-8', skipped, illFormed: false }
  } catch {
    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(body), encoding: 'utf-8', skipped, illFormed: true }
  }
}

// UTF-16 or UTF-32 bytes as a string: `width` bytes to a unit, from
// `start`. A unit that is no character (half of a surrogate pair alone,
// a value past U+10FFFF, bytes left over at the end) is read as U+FFFD.
function units(b: Uint8Array, start: number, width: 2 | 4, big: boolean): { text: string; illFormed: boolean } {
  const out: string[] = []
  let chunk: number[] = []
  let illFormed = false
  const flush = () => {
    out.push(String.fromCharCode.apply(null, chunk))
    chunk = []
  }
  const at = (i: number): number => {
    let v = 0
    for (let k = 0; k < width; k++) v = v * 256 + b[big ? i + k : i + width - 1 - k]
    return v
  }
  const end = b.length - ((b.length - start) % width)
  for (let i = start; i < end; i += width) {
    let cp = at(i)
    if (2 === width) {
      if (0xd800 <= cp && cp < 0xdc00) {
        const low = i + 2 < end ? at(i + 2) : 0
        if (0xdc00 <= low && low < 0xe000) {
          chunk.push(cp, low)
          i += 2
        } else {
          chunk.push(0xfffd)
          illFormed = true
        }
      } else if (0xdc00 <= cp && cp < 0xe000) {
        chunk.push(0xfffd)
        illFormed = true
      } else {
        chunk.push(cp)
      }
    } else if (0x10ffff < cp || (0xd800 <= cp && cp < 0xe000)) {
      chunk.push(0xfffd)
      illFormed = true
    } else if (0xffff < cp) {
      cp -= 0x10000
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else {
      chunk.push(cp)
    }
    if (8192 <= chunk.length) flush()
  }
  if (end < b.length) {
    chunk.push(0xfffd)
    illFormed = true
  }
  flush()
  return { text: out.join(''), illFormed }
}

// The largest text the grammar reads keeping every rule it has run until
// the parse ends. That record is most of what a large text costs in
// memory: about a hundred bytes for each byte of a description.
const HISTORY_OVER = 16 * 1024 * 1024

// The largest text the grammar is given unless the parse says otherwise.
// Under that bound a description of this size takes the memory one of
// `HISTORY_OVER` takes without it, about 1.6 GB, which is what the first
// limit was set by.
const MAX_BYTES = 128 * 1024 * 1024

// The work the grammar is given with a size limit: a rule pass for each
// ten bytes of it, and a hundred thousand passes at least, so that a
// small limit still reads a small text. The largest descriptions take a
// pass for each seven to nine bytes (GitHub's 7.9, Stripe's 9.3 and
// Microsoft Graph's 7.0 and 7.8), so the bound on work comes a little
// before the limit on size for one. At the default limit it is
// 13,421,772 passes.
const BYTES_A_STEP = 10
const STEPS_FLOOR = 100_000

function stepsOf(bytes: number): number {
  return Infinity === bytes ? Infinity : Math.max(STEPS_FLOOR, Math.floor(bytes / BYTES_A_STEP))
}

// An option of `parse` that only `resolve` gives: the text is a document
// of a description other than the description itself. Such a document
// may be anything at its root, a schema that is `true` or a list of
// parameters, and declares no version, so `parse` checks neither. Its
// value is a map `parse` and `resolve` pass word through: `steps` is the
// most rule passes this text may take, where that is fewer than its own
// limit gives it, and `parse` leaves in it the passes the text took
// (`taken`) and what its aliases copied out (`copied`). `resolve` holds
// the documents of one description to one limit with them: see
// `partReader` there.
const PART: unique symbol = Symbol('part')
type Part = { steps?: number; taken?: number; copied?: number }

export { decode, hasContent, utf8Length, stepsOf, HISTORY_OVER, MAX_BYTES, PART }

export type { Part }
