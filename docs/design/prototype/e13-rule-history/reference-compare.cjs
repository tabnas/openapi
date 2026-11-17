// One large document: the tree this package reads under `reading: 'spec'`
// with the rule history bounded at 3 and the limits lifted, against the
// reference parser's tree (the npm `yaml` package, core schema), node by
// node, with a mapping's keys held to their order.
//
//   node --max-old-space-size=11000 reference-compare.cjs <file>
//
// A status line is printed as each of the three steps ends.
const fs = require('node:fs'), path = require('node:path')
const ROOT = path.join(__dirname, '..', '..', '..', '..')
const O = require(path.join(ROOT, 'ts', 'dist', 'openapi.js'))
const YAML = require(path.join(ROOT, 'ts', 'node_modules', 'yaml'))
const file = process.argv[2]
const text = fs.readFileSync(file, 'utf8')
const tick = (what) => console.log(`${what}: ${Math.round(process.uptime())}s, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`)

const tn = O.make({ reading: 'spec' })
tn.options({ rule: { history: 3 } })
const ours = O.parse(text, { reading: 'spec', fast: false, instance: tn, maxBytes: Infinity, aliasBudget: Infinity })
tick('this package read it')
const doc = YAML.parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false })
tick('the reference read it, with ' + doc.errors.length + ' errors')
const ref = doc.toJS({ maxAliasCount: -1 })
tick('the reference built its tree')

let nodes = 0, diffs = 0
const shown = []
const note = (at, a, b) => {
  diffs++
  if (shown.length < 8) shown.push(at + ': ' + String(JSON.stringify(a)).slice(0, 80) + ', and the reference ' + String(JSON.stringify(b)).slice(0, 80))
}
const stack = [['', ours, ref]]
while (stack.length) {
  const [at, a, b] = stack.pop()
  nodes++
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { note(at + ' (a sequence)', Array.isArray(a) ? a.length : typeof a, Array.isArray(b) ? b.length : typeof b); continue }
    for (let i = 0; i < a.length; i++) stack.push([at + '/' + i, a[i], b[i]])
  } else if (null != a && 'object' === typeof a) {
    if (null == b || 'object' !== typeof b) { note(at + ' (a mapping)', 'a mapping', b); continue }
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      note(at + ' (its keys or their order)', ka.slice(0, 6), kb.slice(0, 6))
      if (ka.length !== kb.length || ka.some((k) => !(k in b))) continue
    }
    for (const k of ka) stack.push([at + '/' + k, a[k], b[k]])
  } else if (!Object.is(a, b) && !(Number.isNaN(a) && Number.isNaN(b))) note(at, a, b)
}
console.log(`${path.basename(path.dirname(path.dirname(file)))}: ${nodes} nodes compared, ${diffs} differ`)
for (const s of shown) console.log('  ' + s)
process.exitCode = diffs ? 1 : 0
