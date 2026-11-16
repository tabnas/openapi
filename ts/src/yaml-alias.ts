/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The size a YAML text reaches once every alias is copied in, read from
// the text alone.
//
// The yaml grammar copies an anchor's node in full at every alias, so
// aliases that name anchors that hold aliases grow geometrically: a few
// hundred bytes can ask for gigabytes. `aliasedSize` measures that before
// anything is parsed, so that `parse` can refuse such a text with a code.
//
// The measure is @voxgig/apidef's (its ts/src/yamlalias.ts, MIT, Voxgig
// Ltd), which `parse` stands in for there, and this is that scan: the two
// are held to one table of cases and to each other on real documents. It
// is a scan and not a parse. It finds each anchor with the bytes of the
// node it labels, and each alias, passing over comments, quoted scalars
// and block scalars, and it is right about the documents the grammar
// reads and approximate about the ones it refuses.
//
// The scan is one pass over the text, and then some work that a text can
// be built to multiply: an anchor's node is found by reading on from the
// anchor, and an anchor's size is the sum over the aliases inside it, so
// anchors nested by the thousand cost the square of their number. That
// work is counted, and a text that asks for more than `WORK_PER_BYTE`
// steps for each of its bytes is not measured further: its size is given
// as `Infinity`. No document of the corpus comes near it.

type Anchor = { name: string; start: number; end: number }
type Alias = { name: string; at: number; target?: Anchor }

const SP = 0x20
const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const HASH = 0x23
const DQ = 0x22
const SQ = 0x27
const BSL = 0x5c
const COLON = 0x3a
const COMMA = 0x2c
const DASH = 0x2d
const QMARK = 0x3f
const AMP = 0x26
const STAR = 0x2a
const BANG = 0x21
const LSQ = 0x5b
const RSQ = 0x5d
const LCB = 0x7b
const RCB = 0x7d
const PIPE = 0x7c
const GT = 0x3e

// The steps the measure may take beyond its one pass, for each byte of
// the text and for any text, and how deep an anchor's size may reach
// through aliases to anchors not yet sized, which only an alias inside
// its own anchor can make it do.
const WORK_PER_BYTE = 32
const WORK_FLOOR = 1_000_000
const DEPTH_LIMIT = 64

// What is left of that work. Spending past it ends the measure.
type Work = { left: number }
const PAST = new Error('the alias measure is past its work')
function spend(work: Work, steps: number): void {
  work.left -= steps
  if (work.left < 0) throw PAST
}

const isSpace = (c: number) => SP === c || TAB === c
const isBreak = (c: number) => LF === c || CR === c
const isGap = (c: number | undefined) => undefined === c || isSpace(c) || isBreak(c)

// The size, in bytes of UTF-8, of the text with every alias replaced by
// the node its anchor labels, all the way down. A text with no alias is
// its own size. A text built so that measuring it would take more than a
// fixed number of steps for each byte is `Infinity`.
function aliasedSize(text: string): number {
  return aliasedBytes(new TextEncoder().encode(text))
}

function aliasedBytes(b: Uint8Array): number {
  return measure(b).size
}

// The size, and the steps taken beyond the one pass, which the tests
// hold real documents to.
function measure(b: Uint8Array): { size: number; work: number } {
  if (!b.includes(AMP) || !b.includes(STAR)) return { size: b.length, work: 0 }
  const allowed = WORK_PER_BYTE * b.length + WORK_FLOOR
  const work: Work = { left: allowed }
  try {
    return { size: sized(b, work), work: allowed - work.left }
  } catch (err) {
    if (PAST !== err) throw err
    return { size: Infinity, work: allowed }
  }
}

function sized(b: Uint8Array, work: Work): number {
  const { anchors, aliases } = scan(b, work)
  if (0 === aliases.length) return b.length

  // An alias names the last anchor of its name before it.
  const latest = new Map<string, Anchor>()
  let ai = 0
  for (const alias of aliases) {
    while (ai < anchors.length && anchors[ai].start < alias.at) {
      latest.set(anchors[ai].name, anchors[ai])
      ai++
    }
    alias.target = latest.get(alias.name)
  }

  // An anchor's size is its own bytes and the size of each anchor an
  // alias inside it names. One that reaches itself adds nothing more.
  const sizes = new Map<Anchor, number>()
  const open = new Set<Anchor>()
  const size = (a: Anchor): number => {
    const known = sizes.get(a)
    if (undefined !== known) return known
    if (open.has(a)) return 0
    if (DEPTH_LIMIT <= open.size) throw PAST
    open.add(a)
    let n = a.end - a.start
    for (let x = firstAt(aliases, a.start); x < aliases.length && aliases[x].at < a.end; x++) {
      spend(work, 1)
      const t = aliases[x].target
      if (undefined !== t) n += size(t)
    }
    open.delete(a)
    sizes.set(a, n)
    return n
  }

  let total = b.length
  for (const alias of aliases) {
    if (undefined !== alias.target) total += size(alias.target)
  }
  return total
}

// The index of the first alias at or after a byte offset.
function firstAt(aliases: Alias[], at: number): number {
  let lo = 0
  let hi = aliases.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (aliases[mid].at < at) lo = mid + 1
    else hi = mid
  }
  return lo
}

// The anchors, each with the byte range of the node it labels, and the
// aliases, each with where it stands.
function scan(b: Uint8Array, work: Work): { anchors: Anchor[]; aliases: Alias[] } {
  const anchors: Anchor[] = []
  const aliases: Alias[] = []

  // A block node's anchor ends where a later line returns to its indent.
  // The others end with their bracket or their line.
  const blockAnchors: { anchor: Anchor; indent: number; afterKey: boolean }[] = []
  const bracketAnchors: { anchor: Anchor; depth: number }[] = []

  let flow = 0
  let blockIndent = -1
  let lineIndent = 0
  let lineBegin = 0
  let scalarCol = 0
  let keyCol = 0
  let lineStart = true
  let nodeStart = true
  let afterKey = false
  let i = 0

  while (i < b.length) {
    if (lineStart) {
      lineStart = false
      lineBegin = i
      const j = indentEnd(b, i)
      const blank = j >= b.length || isBreak(b[j]) || HASH === b[j]
      // Inside a block scalar: a blank line, or one indented past its
      // header, is its text.
      if (0 <= blockIndent && (blank || j - i > blockIndent)) {
        i = endOfLine(b, i)
        continue
      }
      blockIndent = -1
      lineIndent = j - i
      if (0 === flow) {
        nodeStart = true
        afterKey = false
      }
      i = j
      continue
    }

    const c = b[i]
    if (LF === c) {
      lineStart = true
      i++
    } else if (CR === c || isSpace(c)) {
      i++
    } else if (HASH === c && isGap(b[i - 1])) {
      i = endOfLine(b, i)
    } else if (nodeStart && (DQ === c || SQ === c)) {
      scalarCol = i - lineBegin
      i = endOfQuoted(b, i)
      nodeStart = false
    } else if (nodeStart && STAR === c) {
      const end = endOfName(b, i + 1)
      aliases.push({ name: decode(b, i + 1, end), at: i })
      nodeStart = false
      i = end
    } else if (nodeStart && AMP === c) {
      const end = endOfName(b, i + 1)
      const anchor: Anchor = { name: decode(b, i + 1, end), start: i, end: b.length }
      anchors.push(anchor)
      let k = end
      while (k < b.length && isSpace(b[k])) k++
      if (k >= b.length || isBreak(b[k]) || HASH === b[k]) {
        blockAnchors.push({ anchor, indent: afterKey ? keyCol : lineIndent, afterKey })
      } else if (LSQ === b[k] || LCB === b[k]) {
        bracketAnchors.push({ anchor, depth: flow + 1 })
      } else {
        anchor.end = 0 < flow ? endOfFlowScalar(b, k) : endOfLine(b, k)
        // Read ahead, and read again by the pass.
        spend(work, anchor.end - k)
      }
      i = end
    } else if (nodeStart && BANG === c) {
      i = endOfName(b, i + 1)
    } else if (nodeStart && 0 === flow && (PIPE === c || GT === c)) {
      blockIndent = lineIndent
      i = endOfLine(b, i)
    } else if (LSQ === c || LCB === c) {
      flow++
      nodeStart = true
      i++
    } else if (RSQ === c || RCB === c) {
      spend(work, bracketAnchors.length)
      for (let x = bracketAnchors.length - 1; 0 <= x; x--) {
        if (bracketAnchors[x].depth === flow) {
          bracketAnchors[x].anchor.end = i + 1
          bracketAnchors.splice(x, 1)
        }
      }
      flow = Math.max(0, flow - 1)
      nodeStart = false
      i++
    } else if (COMMA === c && 0 < flow) {
      nodeStart = true
      i++
    } else if (nodeStart && 0 === flow && (DASH === c || QMARK === c) && isGap(b[i + 1])) {
      i++
    } else if (COLON === c && (0 < flow || isGap(b[i + 1]))) {
      nodeStart = true
      afterKey = 0 === flow
      keyCol = scalarCol
      i++
    } else {
      if (nodeStart) scalarCol = i - lineBegin
      nodeStart = false
      i++
    }
  }

  for (const { anchor, indent, afterKey: keyed } of blockAnchors) {
    const from = endOfLine(b, anchor.start)
    anchor.end = blockEnd(b, from, indent, keyed, work)
    spend(work, from - anchor.start)
  }

  return { anchors, aliases }
}

// The first line after `from` that returns to `indent`. A compact
// sequence under a key may sit at the key's own indent.
function blockEnd(b: Uint8Array, from: number, indent: number, keyed: boolean, work: Work): number {
  let s = from
  while (s < b.length) {
    const was = s
    s = LF === b[s] ? s + 1 : endOfLine(b, s) + 1
    spend(work, s - was)
    if (s >= b.length) break
    const j = indentEnd(b, s)
    if (j >= b.length || isBreak(b[j]) || HASH === b[j]) continue
    const d = j - s
    const entry = DASH === b[j] && isGap(b[j + 1])
    if (d < indent || (d === indent && !(keyed && entry))) return s
  }
  return b.length
}

function indentEnd(b: Uint8Array, i: number): number {
  while (i < b.length && SP === b[i]) i++
  return i
}

function endOfLine(b: Uint8Array, i: number): number {
  while (i < b.length && LF !== b[i]) i++
  return i
}

function endOfQuoted(b: Uint8Array, i: number): number {
  const q = b[i]
  i++
  while (i < b.length) {
    if (DQ === q && BSL === b[i]) {
      i += 2
    } else if (q === b[i] && SQ === q && SQ === b[i + 1]) {
      i += 2
    } else if (q === b[i]) {
      return i + 1
    } else {
      i++
    }
  }
  return i
}

function endOfName(b: Uint8Array, i: number): number {
  while (
    i < b.length &&
    !isGap(b[i]) &&
    COMMA !== b[i] &&
    LSQ !== b[i] &&
    RSQ !== b[i] &&
    LCB !== b[i] &&
    RCB !== b[i] &&
    !(COLON === b[i] && isGap(b[i + 1]))
  ) {
    i++
  }
  return i
}

function endOfFlowScalar(b: Uint8Array, i: number): number {
  while (i < b.length && !isBreak(b[i]) && COMMA !== b[i] && RSQ !== b[i] && RCB !== b[i]) i++
  return i
}

function decode(b: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(b.subarray(start, end))
}

// The budget `parse` holds a text to when it is given none: the larger of
// a megabyte and ten times the text.
const ALIAS_FACTOR = 10
const ALIAS_FLOOR = 1_000_000

function defaultAliasBudget(bytes: number): number {
  return Math.max(ALIAS_FLOOR, ALIAS_FACTOR * bytes)
}

export { aliasedSize, aliasedBytes, defaultAliasBudget, measure }
