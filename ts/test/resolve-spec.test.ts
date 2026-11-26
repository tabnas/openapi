/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The resolver against test/resolve/*.tsv. Each row parses its input,
// resolves it with the row's options, and holds the resolved tree, the
// references left as written (`at why`) and the cut edges to the row; an
// `ERROR:<code>` row holds the code `resolve` raises, and the place the
// error names where the row has one after the code. The other columns
// are optional: `select`, a path into the resolved tree whose value is held
// to `expected` in place of the whole tree; `connections`, the
// connections report, one `kind at -> target` line each (`!why` for a
// target not found, then any flags, and `landing=` where a pointer is
// read on through a reference), with the name after `at` for the
// kinds that read a template or an expression; `provenance`, one
// `at status -> landing` line for each reference, in the order of the
// report (`-` for one that lands nowhere, then `through=`, `uri=`,
// `fragment=` and `conflict=` where the row has them); `dialects`, one
// `at dialect as name` line for each dialect the description declares
// (then ` unknown` for one this package does not know); `urls`, one
// `at base value -> uri` line for each URL the description gives (`-`
// for one with no absolute form); `operations`, one line for each
// operation of the view, which the row's options ask for:
// `at METHOD path`, or `kind:name` in the path's place for a webhook or
// a callback, then `on expression of at` for a callback, `additional`,
// `partial`, `id=`, `params=` with `in:name@at` for each parameter, and `servers=`,
// `security=`, `consumes=`, `produces=` and `schemes=` as `from@at`; and
// `ignored`, one `what at name` line for each thing the specification
// says to ignore, then its kind, `path=`, `method=`, `index=` and
// `additional` where it has them. Every value the view gives is held to
// the resolved tree at its place. Four more say one thing of the result
// each: `version`, the version the description was read by; `dataSlots`,
// how many `$ref` maps were data; `order`, where `yes` holds the members
// of the expected value to the order the row writes them in; and
// `sites`, one `at kind:type "ref" -> target` line for each reference,
// which is what the index made of it before anything was resolved (`-`
// for a target that is in another document or is none). These fixtures live outside
// test/spec/ because the parity runners there read a parse, and because
// the Go and Rust ports do not carry the resolver yet.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadSpec } from '@tabnas/support'

import { parse, resolve, version } from '../dist/openapi'
import { classify, MODEL_VERSIONS } from '../dist/model'
import { OBJECT_MODEL } from '../dist/object-model'

const DIR = join(__dirname, '..', '..', 'test', 'resolve')

const C = (x: any) => JSON.parse(JSON.stringify(x))

// The kinds whose rows say the name too: several of them may be at one
// place.
const NAMED = new Set(['serverVariable', 'template', 'pathClash', 'pathParameter', 'expression', 'linkParameter'])

// One connection as a fixture writes it.
function line(c: any): string {
  let out = `${c.kind} ${c.at}${NAMED.has(c.kind) ? ' ' + c.name : ''} -> ${c.found ? c.target : '!' + (c.why ?? 'missing')}`
  for (const flag of ['via', 'type', 'ambiguous', 'cycle', 'anchor', 'from', 'landing', 'landingDoc']) {
    if (undefined !== c[flag]) out += ` ${flag}=${c[flag]}`
  }
  for (const list of ['targets', 'fields', 'routes']) {
    if (undefined !== c[list]) out += ` ${list}=${c[list].join(',')}`
  }
  return out
}

// One reference's provenance as a fixture writes it.
function where(p: any): string {
  let out = `${p.at} ${p.status} -> ${p.landing ?? '-'}`
  if (undefined !== p.through) out += ' through=' + p.through.join(',')
  if (undefined !== p.uri) out += ' uri=' + p.uri
  if (undefined !== p.fragment) out += ' fragment=' + p.fragment
  if (undefined !== p.conflict) out += ' conflict=' + p.conflict
  return out
}

// One reference as the index read it, as a fixture writes it.
function sited(p: any): string {
  return `${p.at} ${p.kind}${null == p.type ? '' : ':' + p.type} ${JSON.stringify(p.ref)} -> ${p.target ?? '-'}`
}

// One declared dialect as a fixture writes it.
function spoken(d: any): string {
  return `${d.at} ${d.dialect} as ${d.as}` + (d.known ? '' : ' unknown')
}

// One URL as a fixture writes it.
function located(u: any): string {
  return `${u.at} ${u.base} ${u.value} -> ${u.uri ?? '-'}`
}

// One operation of the view as a fixture writes it.
function reached(op: any): string {
  let out = `${op.at} ${op.method} ${'path' === op.kind ? op.path : op.kind + ':' + op.name}`
  if (undefined !== op.expression) out += ` on ${op.expression} of ${op.of}`
  if (op.additional) out += ' additional'
  if (op.partial) out += ' partial'
  if (undefined !== op.operationId) out += ' id=' + op.operationId
  out += ' params=' + (op.parameters.map((p: any) => `${p.in}:${p.name}@${p.at}`).join(',') || '-')
  for (const k of ['servers', 'security', 'consumes', 'produces', 'schemes']) {
    if (undefined !== op[k]) out += ` ${k}=${op[k].from}` + (null === op[k].at ? '' : '@' + op[k].at)
  }
  return out
}

// One thing to ignore as a fixture writes it.
function passed(i: any): string {
  let out = `${i.what} ${i.at} ${i.name}`
  if (undefined !== i.kind) out += ' ' + i.kind
  if (undefined !== i.path) out += ' path=' + i.path
  if (undefined !== i.method) out += ' method=' + i.method
  if (undefined !== i.index) out += ' index=' + i.index
  if (i.additional) out += ' additional'
  return out
}

// The value a tree has at a pointer, or undefined.
function valueAt(tree: any, at: string): any {
  let node = tree
  for (const seg of '' === at ? [] : at.slice(1).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~')
    if (null == node || 'object' !== typeof node || !Object.prototype.hasOwnProperty.call(node, key)) return undefined
    node = node[key]
  }
  return node
}

// What an operation of the view gives is what the resolved tree has at
// the place it says, the same object, and a parameter is the
// operation's own where it is in the operation's list.
function heldToTree(op: any, tree: any, where: string): void {
  assert.strictEqual(op.operation, valueAt(tree, op.at), `${where} ${op.at}: operation`)
  for (const p of op.parameters) {
    assert.strictEqual(p.parameter, valueAt(tree, p.at), `${where} ${p.at}: parameter`)
    assert.equal(p.from, p.at.startsWith(op.at + '/parameters/') ? 'operation' : 'pathItem', `${where} ${p.at}: from`)
  }
  for (const k of ['servers', 'security', 'consumes', 'produces', 'schemes']) {
    const lot = op[k]
    if (undefined === lot) continue
    assert.ok(Array.isArray(lot.value), `${where} ${op.at}: ${k} is a list`)
    if (null === lot.at) {
      assert.deepStrictEqual(lot.value, 'default' === lot.from ? [{ url: '/' }] : [], `${where} ${op.at}: ${k}`)
    } else {
      const held = valueAt(tree, lot.at)
      if (Array.isArray(held)) assert.strictEqual(lot.value, held, `${where} ${op.at}: ${k}`)
    }
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.tsv')).sort()

test('there are resolve fixtures', () => {
  assert.ok(0 < files.length, 'no fixtures in ' + DIR)
})

for (const file of files) {
  const spec = loadSpec(join(DIR, file))
  describe('resolve: ' + file, () => {
    test('has rows', () => {
      assert.ok(0 < spec.rows.length, file + ' has no rows')
    })
    for (const row of spec.rows) {
      const input = row.unescNamed('input')
      test(`row ${row.line}: ${JSON.stringify(input).slice(0, 60)}`, () => {
        const raw = row.named('opts').trim()
        const opts = '' === raw ? {} : JSON.parse(raw)
        const expected = row.named('expected')
        if (expected.startsWith('ERROR:')) {
          // The code, then the place the error names, where the row says it.
          const said = expected.slice('ERROR:'.length)
          const space = said.indexOf(' ')
          const code = -1 === space ? said : said.slice(0, space)
          const at = -1 === space ? undefined : said.slice(space + 1)
          assert.throws(
            () => resolve(parse(input), opts),
            (err: any) => code === err.code && (undefined === at || at === err.at),
            `${file}:${row.line} should raise ${said}`,
          )
          return
        }
        const out = resolve(parse(input), opts)
        const select = row.named('select').trim()
        let value = out.tree
        if ('' !== select) for (const seg of JSON.parse(select)) value = value[seg]
        assert.deepStrictEqual(C(value), JSON.parse(expected), `${file}:${row.line} tree`)
        if ('yes' === row.named('order').trim()) {
          assert.equal(JSON.stringify(value), expected, `${file}:${row.line} the order of the members`)
        }
        const read = row.named('version').trim()
        if ('' !== read) assert.equal(out.version, read, `${file}:${row.line} version`)
        const slots = row.named('dataSlots').trim()
        if ('' !== slots) assert.equal(String(out.dataSlots), slots, `${file}:${row.line} dataSlots`)
        const sites = row.named('sites').trim()
        if ('' !== sites) {
          assert.deepStrictEqual(out.provenance.map(sited), JSON.parse(sites), `${file}:${row.line} sites`)
        }
        assert.deepStrictEqual(
          out.unresolved.map((u) => u.at + ' ' + u.why),
          JSON.parse(row.named('unresolved') || '[]'),
          `${file}:${row.line} unresolved`,
        )
        assert.deepStrictEqual(
          out.cuts.map((c) => c.at),
          JSON.parse(row.named('cuts') || '[]'),
          `${file}:${row.line} cuts`,
        )
        const conns = row.named('connections').trim()
        if ('' !== conns) {
          assert.deepStrictEqual(out.connections.map(line), JSON.parse(conns), `${file}:${row.line} connections`)
        }
        const prov = row.named('provenance').trim()
        if ('' !== prov) {
          assert.deepStrictEqual(out.provenance.map(where), JSON.parse(prov), `${file}:${row.line} provenance`)
        }
        const said = row.named('dialects').trim()
        if ('' !== said) {
          assert.deepStrictEqual(out.dialects.map(spoken), JSON.parse(said), `${file}:${row.line} dialects`)
        }
        const urls = row.named('urls').trim()
        if ('' !== urls) {
          assert.deepStrictEqual(out.urls.map(located), JSON.parse(urls), `${file}:${row.line} urls`)
        }
        const ops = row.named('operations').trim()
        if ('' !== ops) {
          assert.ok(Array.isArray(out.operations), `${file}:${row.line} asks for operations`)
          assert.deepStrictEqual(out.operations!.map(reached), JSON.parse(ops), `${file}:${row.line} operations`)
        }
        for (const op of out.operations ?? []) heldToTree(op, out.tree, `${file}:${row.line}`)
        const ignored = row.named('ignored').trim()
        if ('' !== ignored) {
          assert.deepStrictEqual(out.ignored.map(passed), JSON.parse(ignored), `${file}:${row.line} ignored`)
        }
      })
    }
  })
}

// The object model says which fields hold a URL, and what a relative one
// is relative to, from model/overlay.json. A row that lists a field is
// what holds its entry there to the specification, so every one of them
// has a row, in each version that has the field.
test('every URL field of the object model is in a row of reports.tsv', () => {
  const field = (owner: { type?: string | null }, state: string, member: string | number) =>
    `${owner.type ?? state}.${member}`
  const model = new Set<string>()
  for (const v of MODEL_VERSIONS) {
    const states = (OBJECT_MODEL.versions as any)[v].states as Record<string, any>
    for (const [name, state] of Object.entries(states)) {
      for (const [member, to] of Object.entries((state.props ?? {}) as Record<string, string>)) {
        if (to.startsWith('url:')) model.add(`${v} ${field(state, name, member)} ${to.slice(4)}`)
      }
      // A URL is a named field everywhere it is one: no pattern and no
      // catch-all gives one, which this test could not name.
      for (const [, to] of (state.patterns ?? []) as [string, string][]) assert.ok(!to.startsWith('url:'), `${v} ${name}`)
      assert.ok(!String(state.rest ?? '').startsWith('url:'), `${v} ${name}`)
    }
  }
  const rows = new Set<string>()
  const spec = loadSpec(join(DIR, 'reports.tsv'))
  for (const row of spec.rows) {
    if ('' === row.named('urls').trim()) continue
    const raw = row.named('opts').trim()
    const tree = parse(row.unescNamed('input'))
    const v = version(tree).version as (typeof MODEL_VERSIONS)[number]
    for (const u of resolve(tree, '' === raw ? {} : JSON.parse(raw)).urls) {
      const path = u.at.slice(1).split('/').map((seg: string) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
      const owner = classify(v, path.slice(0, -1))
      rows.add(`${v} ${field(owner, owner.state, path[path.length - 1])} ${u.base}`)
    }
  }
  assert.deepStrictEqual([...rows].sort(), [...model].sort())
})
