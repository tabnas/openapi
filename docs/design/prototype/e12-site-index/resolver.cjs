/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// E12: `resolve` built on the site index, as a prototype.
//
// It is this checkout's own compiled resolver, ts/dist/resolve.js, with
// the seven replacements below and nothing else, so what the prototype
// changes is this list. Each replacement must match the compiled text
// exactly once, or loading fails: the prototype cannot drift from the
// resolver it was measured against without saying so.
//
// It needs a build of @tabnas/expr with `site.written`, which is
// expr-written.diff applied to tabnas/expr at 72962b0 (0.6.3). EXPR_DIST
// names that build's ts/dist/expr.js.
//
//   const { resolve, mode } = require('./resolver.cjs')
//   mode({ typing: true, landings: true, order: 'document' })   // the defaults
//   resolve(raw, options)   // as the package's resolve, with `index` beside the result
//
// With `landings` off a site is read as today, through the sites above
// it, and with `typing` off no region is typed by a reference: with both
// off this is today's resolver with its facts taken from the index.

const Fs = require('node:fs')
const Path = require('node:path')
const Module = require('node:module')

const DIST = process.env.OPENAPI_DIST_DIR || Path.join(__dirname, '..', '..', '..', '..', 'ts', 'dist')
const EXPR = process.env.EXPR_DIST
if (null == EXPR || !Fs.existsSync(EXPR)) {
  throw new Error('resolver.cjs: set EXPR_DIST to the expr build with site.written (see expr-written.diff)')
}

const PROTO = { typing: true, landings: true, order: 'document' }

const REPLACEMENTS = [
  // 1. The patched fold, and the index.
  [
    `const expr_1 = require("@tabnas/expr");`,
    `const expr_1 = require(${JSON.stringify(Path.resolve(EXPR))});
const index_1 = require(${JSON.stringify(Path.join(__dirname, 'index.cjs'))});
const PROTO = globalThis.__E12_PROTO__;`,
  ],

  // 2. The index is built before the fold, and owns the identifiers.
  [
    `    const ids = indexIds(raw, entry, mv);`,
    `    const INDEX = (0, index_1.buildIndex)(raw, {
        mv, docBase, entry, retrieved, rootDialect,
        slots: o.slots, extensions, pointers: 'pointer' === o.refs,
        typing: false !== PROTO.typing, order: PROTO.order,
    });
    const ids = INDEX.ids;`,
  ],

  // 3. `inherit` is a look-up: the index has the state, base URI and
  // dialect of every map the model types. A map it does not have is
  // data, under its parent's base and dialect.
  [
    `            let state = 0 === from ? (0, model_1.rootState)() : k.state;
            let ext = 0 === from ? false : k.ext;
            for (const m of site.path.slice(from)) {
                state = (0, model_1.step)(mv, state, m);
                if (!ext && extensions.has(String(m)))
                    ext = true;
            }
            let base = k.base;
            let dialect = k.dialect;
            if (hasIds(mv) && 'schema' === (0, model_1.slot)(mv, state).kind && (0, uri_1.isMap)(node)) {
                if ('string' === typeof node.$schema)
                    dialect = node.$schema;
                if ('string' === typeof node.$id)
                    base = (0, uri_1.resolveUri)(base, node.$id);
            }
            return { state, depth: site.path.length, base, dialect, ext };`,
    `            let ext = 0 === from ? false : k.ext;
            for (const m of site.path.slice(from)) {
                if (!ext && extensions.has(String(m)))
                    ext = true;
            }
            const rec = INDEX.typed.get((0, uri_1.pointer)(site.path));
            if (null != rec)
                return { state: rec.state, depth: site.path.length, base: rec.base, dialect: rec.dialect, ext };
            return { state: 'data', depth: site.path.length, base: k.base, dialect: k.dialect, ext };`,
  ],

  // 4. `recognise` is a look-up: a map is a site where the index has one.
  [
    `            const kind = kindOf(site.k.state);
            if ('$dynamicRef' === op.src)
                return !pointers && 'schema' === kind && hasIds(mv);
            const ref = site.node.$ref;
            let k = kind;
            if (null == k) {
                dataSlots++;
                if ('string' !== typeof ref || ('all' !== o.slots && true !== site.k.ext))
                    return false;
                k = 'data';
            }
            // Under \`refs: 'pointer'\` the root is where pointers start, never a
            // site of its own.
            if (pointers && 0 === site.path.length)
                return false;
            const s = (0, model_1.slot)(mv, site.k.state);
            const info = {
                seq: seq++,
                at: (0, uri_1.pointer)(site.path),
                kind: k,
                type: 'reference' === k ? s.type : 'pathItem' === k || 'schema' === k ? k : null,
                ref,
                status: 'resolved',
            };
            if (null != site.token)
                info.token = site.token;
            if ('string' !== typeof ref)
                info.why = 'not-a-string';
            else if (!pointers && 'schema' === k && hasIds(mv) && !supportedDialect(site.k.dialect))
                info.why = 'unsupported-dialect';
            else {
                const where = locate(ref, site.k.base);
                if (null != where.why)
                    info.why = where.why;
                else {
                    info.target = where.target;
                    const key = (0, uri_1.pointer)(where.target);
                    if ('inline-once' === o.sharing && !firstFor.has(key))
                        firstFor.set(key, info.seq);
                }
            }`,
    `            const at = (0, uri_1.pointer)(site.path);
            if ('$dynamicRef' === op.src)
                return INDEX.dynamic.has(at);
            const row = INDEX.sites.get(at);
            if (null == row)
                return false;
            const info = { seq: seq++, at, kind: row.kind, type: row.type, ref: row.ref, status: 'resolved', row };
            if (null != site.token)
                info.token = site.token;
            if (null != row.why)
                info.why = row.why;
            else {
                info.target = row.target;
                const key = (0, uri_1.pointer)(row.target);
                if ('inline-once' === o.sharing && !firstFor.has(key))
                    firstFor.set(key, info.seq);
            }`,
  ],

  // 5. `evaluate` folds the landing, as the document is written. Under
  // refs: 'pointer' the reading stays apidef's, which is today's.
  [
    `            const hit = site.at(info.target);
            const via = pointers && !hit.cycle ? throughLeft(info.target) : undefined;`,
    `            let hit;
            let via;
            if (pointers || false === PROTO.landings) {
                hit = site.at(info.target);
                via = pointers && !hit.cycle ? throughLeft(info.target) : undefined;
            }
            else {
                const land = info.row.landing;
                hit = land.loop ? { found: true, cycle: true }
                    : !land.found ? { found: false, cycle: false }
                        : site.written(land.path);
            }`,
  ],

  // 6. Under 'keep', a site's value is read at its landing: the finished
  // tree walked along the landing's path, a site on the way stepped
  // through as the map it is written as.
  [
    `            // A reference to the whole document lands on the root itself, which
            // may be a site.
            if (0 === d.info.target.length) {
                node = root;
                land();
            }
            for (const seg of d.info.target) {`,
    `            const onLanding = !pointers && false !== PROTO.landings;
            if (onLanding) {
                const lr = d.info.row.landing;
                if (lr.loop)
                    node = LOOP;
                else if (!lr.found)
                    node = uri_1.NOTHING;
                else {
                    if (0 === lr.path.length)
                        node = root;
                    for (const seg of lr.path) {
                        if (deferred.has(node))
                            node = deferred.get(node).plain;
                        node = (0, uri_1.stepInto)(node, seg);
                        if (uri_1.NOTHING === node)
                            break;
                    }
                    land();
                }
            }
            // A reference to the whole document lands on the root itself, which
            // may be a site.
            if (!onLanding && 0 === d.info.target.length) {
                node = root;
                land();
            }
            for (const seg of onLanding ? [] : d.info.target) {`,
  ],

  // 7. The count of data slots is the index's, and the index is returned.
  [
    `        connections,
        dataSlots,
    };`,
    `        connections,
        dataSlots: INDEX.dataSlots,
        index: INDEX,
    };`,
  ],
]

function build() {
  const file = Path.join(DIST, 'resolve.js')
  let src = Fs.readFileSync(file, 'utf8')
  REPLACEMENTS.forEach(([from, to], i) => {
    const n = src.split(from).length - 1
    if (1 !== n) throw new Error(`resolver.cjs: replacement ${i + 1} matches ${n} times in ${file}, not once`)
    src = src.replace(from, () => to)
  })
  globalThis.__E12_PROTO__ = PROTO
  const m = new Module(file, module)
  m.filename = file
  m.paths = Module._nodeModulePaths(Path.dirname(file))
  m._compile(src, file)
  return m.exports
}

const built = build()

function mode(next) {
  if (null != next) Object.assign(PROTO, next)
  return { ...PROTO }
}

module.exports = { resolve: built.resolve, ResolveError: built.ResolveError, mode, REPLACEMENTS }
