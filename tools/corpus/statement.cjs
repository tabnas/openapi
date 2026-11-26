#!/usr/bin/env node
/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The figures of docs/conformance.md, written from the records that the
// corpus tools keep: the two baselines and their ledgers, the accepted
// rows, the record of the documents run, and the pinned sources. The
// page's prose is written by hand, and its figures are this tool's, so
// that a sweep that moves a figure moves the page or fails the suite.
//
//   node tools/corpus/statement.cjs            print the figures
//   node tools/corpus/statement.cjs --write    write them into the page
//   node tools/corpus/statement.cjs --check    end with 1 if the page is stale
//
// It reads nothing but those records, and takes well under a second.

const Fs = require('node:fs')
const Path = require('node:path')

const ROOT = Path.join(__dirname, '..', '..')
const PAGE = Path.join(ROOT, 'docs', 'conformance.md')
const OPEN = '<!-- figures: written by tools/corpus/statement.cjs, never by hand -->'
const CLOSE = '<!-- /figures -->'

const read = (rel) => Fs.readFileSync(Path.join(ROOT, rel), 'utf8')
const json = (rel) => JSON.parse(read(rel))

// A count, with a comma at each thousand.
const n = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + b, 0)
// A table. A bar in a cell would end the cell, so it is written escaped.
const cell = (v) => String(v).replace(/\|/g, '\\|')
const table = (head, rows) => [
  '| ' + head.map(cell).join(' | ') + ' |',
  '|' + head.map((h, i) => (0 === i ? '---' : '---:')).join('|') + '|',
  ...rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |'),
]

// A table of tab-separated values, as the ledgers are.
function tsv(rel) {
  const lines = read(rel).split('\n').filter((l) => '' !== l)
  const head = lines[0].split('\t')
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])))
}

// The class of a ledger row: its outcome, and its detail without the
// counts, so that rows of one cause are counted together.
const classOf = (row) => row.outcome + ' ' + row.detail.split('; ').map((d) => d.replace(/=\d+$/, '')).join('; ')

function figures() {
  const sources = json('tools/corpus/sources.json').sources
  const base = json('test/corpus/baseline.json')
  const spec = json('test/corpus/baseline-spec.json')
  const accepted = tsv('test/corpus/accepted.tsv')
  const ledgerBase = tsv('test/corpus/ledger.tsv')
  const ledgerSpec = tsv('test/corpus/ledger-spec.tsv')
  const docs = json('test/corpus/documents.json').sources
  const out = []
  const say = (...lines) => out.push(...lines, '')

  // ---- the corpus ----
  say('### The corpus')
  const by = spec.documents.bySource
  const named = Array.isArray(sources) ? sources : Object.values(sources)
  say(
    ...table(
      ['Source', 'Commit', 'Documents', 'Descriptions'],
      named.map((s) => [
        '`' + s.repository + '`' + (s.name === s.repository.split('/')[1] ? '' : ', as `' + s.name + '`'),
        '`' + String(s.commit).slice(0, 12) + '`',
        n(by[s.name]?.documents ?? 0),
        n(by[s.name]?.descriptions ?? 0),
      ]),
    ),
  )
  say(
    `${n(spec.documents.total)} documents, of which ${n(spec.documents.descriptions)} are descriptions: a document`,
    `whose root declares a version. The other ${n(spec.documents.fragments)} are the parts of descriptions in`,
    'several documents, and test documents that are not descriptions.',
  )
  const versions = Object.keys(spec.documents.byVersion)
  say(
    ...table(
      ['Version declared', 'YAML', 'JSON'],
      versions.map((v) => [
        'unknown' === v ? 'none' : 'not-a-map' === v ? 'none: the root is no map' : v,
        n(spec.documents.byVersion[v].yaml ?? 0),
        n(spec.documents.byVersion[v].json ?? 0),
      ]),
    ),
  )

  // What of YAML the documents use, each as the count of documents that
  // use it.
  const y = spec.yamlFeatures
  const uses = [
    ['a block scalar', y.blockScalars],
    ['a flow collection', y.flowCollections],
    ['an anchor', y.anchors],
    ['an alias', y.aliases],
    ['a document start marker', y.documentStart],
    ['a merge key', y.mergeKeys],
    ['a tag', y.tags],
    ['a directive', y.directives],
    ['a key that is no string', y.nonStringKeys],
    ['a complex key', y.complexKeys],
    ['more than one document in the text', y.multiDocument],
  ]
  say(`Of the ${n(y.documents)} YAML documents, the count that use each feature of YAML:`)
  say(...table(['Feature', 'Documents'], uses.map(([what, count]) => [what, n(count)])))

  // ---- reading ----
  say('### Reading')
  const codes = (b) => {
    const c = b.parse.refusedByCode
    const names = Object.keys(c).sort()
    return 0 === names.length ? 'none' : names.map((k) => `${n(c[k])} \`${k}\``).join(', ')
  }
  const row = (what, f) => [what, f(spec), f(base)]
  say(
    ...table(
      ['', "`reading: 'spec'`", 'the base reading'],
      [
        row('Documents read', (b) => `${n(b.parse.all.parsed)} of ${n(b.documents.total)}`),
        row('Descriptions read', (b) => `${n(b.parse.descriptions.parsed)} of ${n(b.documents.descriptions)}`),
        row('Refused', codes),
        row('Ended without an error or a tree', (b) => n(b.parse.all.died)),
        row('Trees compared with the reference parser', (b) => n(b.trees.compared)),
        row('Trees that differ', (b) => n(b.trees.differ)),
        row('Ledger rows', (b) => n(b.ledger.rows)),
        row('Accepted, each with its reason', (b) => n(b.ledger.accepted)),
        row('Open', (b) => n(b.ledger.open)),
      ],
    ),
  )
  say(
    `The reference parser is \`yaml\` ${spec.environment.reference.yaml}, read under the core schema of YAML 1.2.`,
    `Of the ${n(spec.json.documents)} JSON documents, the grammar gives the tree that \`JSON.parse\` gives for`,
    `${n(spec.json.grammarEqualsJsonParse)}, differs on ${n(spec.json.grammarDiffers)} and refuses ${n(spec.json.grammarRefused)}. Under \`strict\`, ${n(spec.json.strictAccepts)} are accepted,`,
    `and ${n(sum(spec.json.strictRefusesByCode))} are refused for declaring no version this package reads.`,
  )
  say("The rows of the ledger under `reading: 'spec'`, with the reason each is accepted:")
  const reasonOf = new Map(accepted.map((a) => [a.source + '\t' + a.path, a.reason]))
  for (const r of ledgerSpec) {
    out.push(`- \`${r.source}\`, \`${r.path}\`: ${r.outcome}, \`${r.detail}\`. ${reasonOf.get(r.source + '\t' + r.path) ?? 'OPEN: no reason is recorded.'}`)
  }
  out.push('')
  const classes = new Map()
  for (const r of ledgerBase) classes.set(classOf(r), (classes.get(classOf(r)) ?? 0) + 1)
  say('The rows of the ledger under the base reading, by what each row says:')
  say(...table(['Outcome and class', 'Documents'], [...classes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, c]) => ['`' + k + '`', n(c)])))

  // ---- resolving ----
  say('### Resolving')
  const r = spec.resolve
  say(
    `Under \`reading: 'spec'\`, each of the ${n(r.resolved)} descriptions is resolved by itself, with the default`,
    `options and no other document given. None threw. They hold ${n(r.sites)} references:`,
  )
  say(
    ...table(
      ['References', 'Count'],
      [
        ['Resolved', n(r.status.resolved)],
        ['Cut, where a cycle closes', n(r.status.cut)],
        ...Object.keys(r.unresolved)
          .sort()
          .map((why) => [`Left as written, \`${why}\``, n(r.unresolved[why])]),
        ['Reported resolved and holding the map as written', n(r.heldAsWritten)],
      ],
    ),
  )
  say(
    `The ${n(r.unresolved.external ?? 0)} external references name documents that this run did not give, in ${n(r.documentsByUnresolved.external ?? 0)}`,
    `descriptions. The run below gives them. ${n(r.documentsWithCuts)} descriptions have a cycle. ${n(r.dataSlots)} maps with a`,
    '`$ref` member are data where they are, an example or an extension, and are left alone.',
  )
  say('What the descriptions name without a reference, by kind of name:')
  const kinds = Object.keys(r.connections).sort()
  say(...table(['Kind', 'Names', 'Found nothing'], kinds.map((k) => ['`' + k + '`', n(r.connections[k].count), n(r.connections[k].notFound)])))
  say(
    `The operation view gives ${n(r.operations.count)} operations: ${Object.keys(r.operations.byKind)
      .sort()
      .map((k) => `${n(r.operations.byKind[k])} by ${k}`)
      .join(', ')}.`,
    `${n(r.operations.partial)} lack a parameter that is in a document this run did not give. The \`ignored\` report`,
    `lists ${n(sum(r.ignored.byWhat))} headers that the specification says to ignore, in ${n(r.ignored.documents)} descriptions.`,
  )

  // ---- several documents ----
  say('### Several documents')
  const names = Object.keys(docs)
  say(
    ...table(
      ['Source', 'Descriptions', 'In several documents', 'Documents loaded', 'References', 'Resolved', 'Cut', 'Left as written'],
      names.map((k) => {
        const d = docs[k]
        return ['`' + k + '`' + ('all' === d.options?.slots ? ", under `slots: 'all'`" : ''), n(d.descriptions), n(d.inSeveralDocuments), n(d.documentsLoaded), n(d.sites), n(d.resolved), n(d.cut), n(sum(d.unresolved))]
      }),
    ),
  )
  const all = names.map((k) => docs[k])
  const total = (f) => all.reduce((a, d) => a + f(d), 0)
  say(
    `${n(total((d) => d.descriptions))} descriptions, each resolved from its own file with \`resolveAll\` and the file`,
    `loader. ${n(total((d) => d.threw))} threw, and ${n(total((d) => d.externalOnDisk))} left a reference to a document that is on disk.`,
  )
  say(
    ...table(
      ['Source', 'Bundles that agree', 'That differ', 'Targets among the components', 'In the place of a reference', 'Left'],
      names.map((k) => {
        const b = docs[k].bundle
        return ['`' + k + '`', n(b.agree), n(b.differ + b.threw), n(b.component + b.defs), n(b.inline), n(sum(b.left))]
      }),
    ),
  )
  say(
    `Each description is then written as one document with \`bundleAll\`. A bundle agrees when it`,
    `resolves to what its documents resolve to: ${n(total((d) => d.bundle.agree))} of ${n(total((d) => d.descriptions))} do.`,
  )

  // ---- the environment ----
  say('### What the figures were measured on')
  const deps = spec.environment.dependencies
  say(
    `\`${spec.environment.package.name}\` ${spec.environment.package.version} on Node.js ${spec.environment.node}, with ${Object.keys(deps)
      .sort()
      .map((k) => `\`${k}\` ${deps[k]}`)
      .join(', ')}.`,
  )
  while ('' === out[out.length - 1]) out.pop()
  return out.join('\n')
}

// The page with its figures replaced.
function withFigures(page, block) {
  const a = page.indexOf(OPEN)
  const b = page.indexOf(CLOSE)
  if (a < 0 || b < a) throw new Error('statement: docs/conformance.md has no figures block')
  return page.slice(0, a + OPEN.length) + '\n\n' + block + '\n\n' + page.slice(b)
}

module.exports = { figures, withFigures, OPEN, CLOSE, PAGE }

if (require.main === module) {
  const block = figures()
  if (process.argv.includes('--write')) {
    Fs.writeFileSync(PAGE, withFigures(Fs.readFileSync(PAGE, 'utf8'), block))
    console.log('statement: wrote the figures into docs/conformance.md')
  } else if (process.argv.includes('--check')) {
    const page = Fs.readFileSync(PAGE, 'utf8')
    if (page !== withFigures(page, block)) {
      console.error('statement: docs/conformance.md is stale: run node tools/corpus/statement.cjs --write')
      process.exit(1)
    }
    console.log('statement: docs/conformance.md has the recorded figures')
  } else console.log(block)
}
