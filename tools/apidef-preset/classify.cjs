/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/classify.cjs: the classes of difference, by cause.
//
// compare.cjs finds the sites (maps with a `$ref`) where apidef's tree and
// the preset's differ. Each such site is given the first class below whose
// test it meets. A site that meets none, but whose target overlaps another
// differing site (it names that site, or a place inside it, or a place
// that site's own target holds), or that differs only below its own top
// level, is a consequence of that other difference, not a cause, and is
// counted as `follows`. A site that meets nothing at all is `unclassified`
// with a signature, so that a new cause shows itself rather than hiding in
// a known class.
//
// Each class says what kind of difference it is: `content` (the trees
// hold different members or values), `order` (the same members in a
// different order) or `sharing` (the same content, with different
// objects shared).
//
// A module for compare.cjs and apidef-preset.cjs; it runs nothing by itself.

const G = require('./graph.cjs')

const own = (o, k) => G.isObj(o) && Object.prototype.hasOwnProperty.call(o, k)
const isAlias = (n) => G.isObj(n) && !Array.isArray(n) && 'string' === typeof n.$ref
const ANCHOR = /^[A-Za-z_][-A-Za-z0-9._]*$/
const BAD_TILDE = /~(?![01])/

// apidef's reading of a pointer's segments (parse.ts 393-399): `#/` and
// then split on `/`, `~1` then `~0`, nothing decoded.
const apidefParts = (ref) =>
  'string' === typeof ref && ref.startsWith('#/')
    ? ref.substring(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    : null

const partsOf = (pointer) =>
  null == pointer ? null : '' === pointer ? [] : pointer.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))

const prefix = (a, b) => a.length <= b.length && a.every((x, i) => String(x) === String(b[i]))

// Whether a map on the path from the root to a site (the site included)
// has a string `$id`.
function underId(raw, path) {
  let node = raw
  if (own(node, '$id') && 'string' === typeof node.$id) return true
  for (const p of path) {
    node = G.isObj(node) ? node[p] : undefined
    if (own(node, '$id') && 'string' === typeof node.$id) return true
  }
  return false
}

// Where apidef's pointer walk first steps through a `$ref` map it cannot
// follow, reading a member written beside that `$ref`: the prefix, or null.
// apidef follows every reference met on the way (followAlias, parse.ts
// 398 and 411-417) and stops when one names nothing (414).
function unfollowable(raw, A, parts) {
  if (null == parts) return null
  let node = raw
  for (let i = 0; i < parts.length; i++) {
    if (isAlias(node)) {
      const t = A.resolvePointer(raw, node.$ref)
      if (undefined === t) return parts.slice(0, i)
      // A followable reference: its own member wins, else its target's.
      if (!own(node, parts[i])) node = t
    }
    if (!own(node, parts[i]) && !(Array.isArray(node) && /^(0|[1-9]\d*)$/.test(parts[i]))) return null
    node = node[parts[i]]
  }
  return null
}

const asWrittenA = (d) => 'as written' === d.apidef
const resolvedA = (d) => 'resolved' === d.apidef
const resolvedP = (d) => String(d.preset).startsWith('resolved')
const leftP = (d) => /^(unresolved|cut)/.test(String(d.preset))

// The classes, in the order they are tried. The preset shows none of
// them: each names a way a resolver that reads references as the
// specification does, or follows them while it builds the tree, departs
// from apidef's, so that a difference which comes back is named by its
// cause. `apidef`: what apidef's resolver does. `lines`: the lines of
// apidef's ts/src/parse.ts (at 3b24341) that do it. `other`: what the
// other reading gives. `where`: what in ts/src/resolve.ts holds the
// preset to apidef.
const CLASSES = [
  {
    id: 'root-site',
    kind: 'content',
    title: 'a $ref in the root map',
    apidef: 'never a site: the walk reads the root\'s members, never the root itself; the root keeps its $ref and gains no x-ref',
    lines: '325-336 (addXRefsAndResolve resolves a child `val`, never `obj` itself)',
    other: 'the root read as a site like any other: resolved and merged, or left as written with x-ref',
    where: '`recognise` makes no site of the root under `refs: \'pointer\'`',
    test: (d) => 0 === d.path.length,
  },
  {
    id: 'root-alias-blocks-pointers',
    kind: 'content',
    title: 'every pointer, in a document whose root has a $ref',
    apidef: 'every pointer walk starts by following the root as a reference, which names nothing (it needs itself, or its target is missing), so no pointer resolves',
    lines: '396-398 (node = root; followAlias(root, node, ...) before the first segment), 393 (active), 414',
    other: 'pointers read from the root as written, whatever $ref the root has',
    where: '`rootIsReference`: `locatePointer` gives every pointer `not-found`',
    test: (d, c) => asWrittenA(d) && resolvedP(d) && isAlias(c.raw) && null != apidefParts(d.ref) && undefined === c.A.resolvePointer(c.raw, c.raw.$ref),
  },
  {
    id: 'preset-bare-site',
    kind: 'content',
    title: 'a site left as written without its x-ref: a reference that closes a cycle, named by a reference written before it',
    apidef: 'resolves the edge in place and every site gains x-ref, whatever the order of the walk',
    lines: '343-353 (resolveRefSite: replaceOwnKeys or site[\'x-ref\'], always), 331-332',
    other: 'the fold, following a reference, comes to a container that is still being folded and takes the map as written for it, unresolved and unreported, though provenance says resolved',
    where: 'under `cycles: \'keep\'` `evaluate` gives every site a placeholder and follows nothing; `keepCycles` settles each on the finished tree',
    test: (d) => true === d.presetBare,
  },
  {
    id: 'unsupported-dialect',
    kind: 'content',
    title: 'a schema $ref under a dialect the package does not support',
    apidef: 'ignores dialects: resolved',
    lines: '392-405 (resolvePointer knows no $schema or jsonSchemaDialect)',
    other: 'a schema $ref under a dialect the package does not read is left as written, `unsupported-dialect`',
    where: '`recognise` reads no dialect under `refs: \'pointer\'`',
    test: (d) => / \(unsupported-dialect\)/.test(d.preset),
  },
  {
    id: 'proto-sibling',
    kind: 'content',
    title: 'a member named __proto__ beside a $ref',
    apidef: 'dropped: refSiblings copies the siblings by assignment into a plain {}, where `__proto__` sets the prototype instead of making a member',
    lines: '307-310 (out[k] = node[k]), then 347 and 415-416 spread what is left',
    other: 'kept: `merged` defines each member, so `__proto__` is data',
    where: '`settleSite` leaves a `__proto__` sibling out under `compat: \'apidef\'`',
    test: (d) => resolvedA(d) && resolvedP(d) && Array.isArray(d.pKeys) && Array.isArray(d.aKeys) && d.pKeys.includes('__proto__') && !d.aKeys.includes('__proto__'),
  },
  {
    id: 'xref-position',
    kind: 'order',
    title: 'x-ref before the site\'s own members, when the target is a site apidef resolved earlier',
    apidef: 'a target already resolved in place carries its own x-ref; the spread keeps that member\'s place and only overwrites its value, so x-ref comes before members the site adds',
    lines: '347 ({ ...resolved, ...refSiblings(site), \'x-ref\': xref } with `resolved` already holding x-ref), order of the walk 328-336',
    other: 'x-ref always last: the target\'s own x-ref is taken off before the merge, and the site\'s is defined last',
    where: 'under `compat: \'apidef\'`, `orderAsWalked` puts each resolved site\'s members in the order a walk in place leaves',
    test: (d) => true === d.reordered && sameButXref(d.aKeys, d.pKeys) && d.aKeys.indexOf('x-ref') < d.pKeys.indexOf('x-ref'),
  },
  {
    id: 'id-base',
    kind: 'content',
    title: 'a fragment reference inside a schema that has an $id (3.1, 3.2, no version)',
    apidef: 'reads every `#/...` from the document root; ignores $id',
    lines: '393, 396 (node = root)',
    other: 'the fragment read against the base the nearest $id gives, so `#/...` starts at that schema',
    where: '`locatePointer` reads every pointer from the root',
    test: (d, c) => 'string' === typeof d.ref && d.ref.startsWith('#') && underId(c.raw, d.path) && (asWrittenA(d) !== !resolvedP(d) || 'top' === d.how),
  },
  {
    id: 'whole-document',
    kind: 'content',
    title: '$ref: \'#\' or \'\' (the whole document)',
    apidef: 'not a `#/` pointer: left as written',
    lines: '393',
    other: 'an empty or absent fragment names the document root, so the site holds the whole document',
    where: '`locatePointer`: a reference that does not begin `#/` names nothing',
    test: (d) => asWrittenA(d) && resolvedP(d) && ('' === d.ref || '#' === d.ref),
  },
  {
    id: 'uri-by-id',
    kind: 'content',
    title: 'a reference by a schema\'s $id URI (3.1, 3.2, no version)',
    apidef: 'only `#/` pointers resolve: left as written',
    lines: '393',
    other: 'each $id is indexed, and a URI that names one resolves to that schema',
    where: '`locatePointer`: a reference that does not begin `#/` names nothing',
    test: (d, c) => asWrittenA(d) && resolvedP(d) && 'string' === typeof d.ref && !d.ref.startsWith('#') && hasIdAt(c.raw, d.presetTarget),
  },
  {
    id: 'uri-by-self',
    kind: 'content',
    title: 'a same-document reference written with the document\'s own URI ($self, 3.2 or no version)',
    apidef: 'only `#/` pointers resolve: left as written',
    lines: '393',
    other: 'the document\'s base is its $self, and a URI under it names this document',
    where: '`locatePointer`: a reference that does not begin `#/` names nothing',
    test: (d, c) => asWrittenA(d) && resolvedP(d) && 'string' === typeof d.ref && !d.ref.startsWith('#') && own(c.raw, '$self'),
  },
  {
    id: 'uri-by-default-base',
    kind: 'content',
    title: 'a same-document reference written with the URN the package reads a document with no location under',
    apidef: 'only `#/` pointers resolve: left as written',
    lines: '393',
    other: 'the URN is the retrieval URI of a document with no location, and a URI under it names this document',
    where: '`locatePointer`: a reference that does not begin `#/` names nothing',
    test: (d) => asWrittenA(d) && resolvedP(d) && 'string' === typeof d.ref && !d.ref.startsWith('#'),
  },
  {
    id: 'anchor',
    kind: 'content',
    title: 'a plain-name fragment naming an $anchor or $dynamicAnchor (3.1, 3.2, no version)',
    apidef: 'not a `#/` pointer: left as written',
    lines: '393',
    other: 'a plain-name fragment is looked up among the anchors the document declares',
    where: '`locatePointer`: a reference that does not begin `#/` names nothing',
    test: (d) => asWrittenA(d) && resolvedP(d) && 'string' === typeof d.ref && d.ref.startsWith('#') && ANCHOR.test(d.ref.slice(1)),
  },
  {
    id: 'percent-decoded',
    kind: 'content',
    title: 'a percent-encoded pointer (including a fragment starting %2F)',
    apidef: 'reads the fragment as written, undecoded: a `%xx` names a member with `%xx` in its name, and `#%2F...` is not a `#/` pointer',
    lines: '393, 397-399 (no decoding)',
    other: 'the fragment is percent-decoded first, and one starting %2F is read as a pointer',
    where: '`locatePointer` decodes `~1` and `~0` and nothing else',
    test: (d) => asWrittenA(d) && resolvedP(d) && 'string' === typeof d.ref && d.ref.includes('%'),
  },
  {
    id: 'percent-literal',
    kind: 'content',
    title: 'a pointer naming a member whose name holds a percent sign, written as it is',
    apidef: 'resolved: the segment is the member name as written',
    lines: '397-399',
    other: 'the `%` is decoded (not-found), or refused where it is not an escape (bad-fragment)',
    where: '`locatePointer` decodes `~1` and `~0` and nothing else',
    test: (d) => resolvedA(d) && leftP(d) && 'string' === typeof d.ref && d.ref.includes('%'),
  },
  {
    id: 'bad-tilde',
    kind: 'content',
    title: 'a pointer with a `~` not followed by 0 or 1 (`~2`, a trailing `~`)',
    apidef: 'resolved when a member is named with that `~` as written: only `~1` and `~0` are replaced',
    lines: '399',
    other: 'the fragment is refused (bad-fragment) and the site left as written',
    where: '`locatePointer` decodes `~1` and `~0` and nothing else',
    test: (d) => resolvedA(d) && / \(bad-fragment\)/.test(d.preset) && 'string' === typeof d.ref && BAD_TILDE.test(d.ref),
  },
  {
    id: 'member-of-unfollowable',
    kind: 'content',
    title: 'a pointer through a member written beside a $ref that names nothing (missing, external, a cycle, a list or a scalar)',
    apidef: 'follows the $ref before reading the next member; it names nothing, so the pointer names nothing: left as written',
    lines: '398 (followAlias before each segment), 414 (an alias that names nothing gives undefined), 400',
    other: 'the member beside the $ref read as written: a site left as written keeps its other members, and a pointer into them resolves',
    where: '`keepCycles` ends a walk at a site left as written (`NOTHING`); under `cycles: \'cut\'`, `throughLeft` does',
    test: (d, c) => asWrittenA(d) && resolvedP(d) && null != unfollowable(c.raw, c.A, apidefParts(d.ref)),
  },
  {
    id: 'pointer-through-cycle',
    kind: 'content',
    title: 'a pointer that steps through a reference closing a cycle, after entering the cycle by another reference',
    apidef: 'follows each reference met on the way afresh (only a pointer string already being resolved stops it), so the walk goes round the cycle and lands: resolved',
    lines: '392-405, 411-417 (active holds pointer strings, not places)',
    other: 'the pointer read while the tree is being built, where the edge that closes the cycle is not there yet: `not-found`',
    where: '`keepCycles` reads every pointer on the finished tree, settling each reference it meets',
    // Not where the walk passes another site that differs: that is a
    // consequence of the other difference.
    test: (d) => resolvedA(d) && / \(not-found\)/.test(d.preset) && null != apidefParts(d.ref) && !d.onDiffering,
  },
]

function sameButXref(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  const strip = (k) => k.filter((x) => 'x-ref' !== x).join('\0')
  return strip(a) === strip(b) && a.join('\0') !== b.join('\0')
}

function hasIdAt(raw, pointer) {
  const parts = partsOf(pointer)
  if (null == parts) return false
  const node = G.at(raw, parts)
  return own(node, '$id')
}

const BY_ID = new Map(CLASSES.map((c) => [c.id, c]))

// The classes of one compared document: the set of causes, one per
// differing site that is not a consequence of another. Each differing site
// gets `.cls`.
function classify(rec, c) {
  const diffs = rec.differing ?? []
  const overlaps = (d) => {
    const targets = [apidefParts(d.ref), partsOf(d.presetTarget)].filter(Boolean)
    return diffs.some((e) => e !== d && targets.some((t) => prefix(e.path, t) || prefix(t, e.path)))
  }
  for (const d of diffs) d.onDiffering = overlaps(d)
  for (const d of diffs) {
    for (const k of CLASSES) {
      let hit
      try {
        hit = k.test(d, c)
      } catch {
        hit = false
      }
      if (hit) {
        d.cls = k.id
        break
      }
    }
  }
  // Consequences: a site whose target overlaps another differing site.
  for (const d of diffs) {
    if (null != d.cls) continue
    if (d.onDiffering || 'below' === d.how) d.cls = 'follows'
  }
  for (const d of diffs) {
    if (null == d.cls) d.cls = 'unclassified: ' + signature(d)
  }
  const out = [...new Set(diffs.map((d) => d.cls).filter((k) => 'follows' !== k))]
  if (0 === out.length) {
    out.push(0 === diffs.length ? 'unattributed: ' + (rec.first?.what ?? 'unknown') : 'unattributed: only consequences')
  }
  return out
}

function signature(d) {
  const form =
    'string' !== typeof d.ref ? 'non-string'
      : '' === d.ref ? 'empty'
        : d.ref.startsWith('#/') ? 'pointer'
          : d.ref.startsWith('#') ? 'fragment'
            : 'uri'
  return `${form}, apidef ${d.apidef}, preset ${d.preset}, ${d.how}${d.orderOnly ? ', order only' : ''}`
}

module.exports = { classify, CLASSES, BY_ID, apidefParts }
