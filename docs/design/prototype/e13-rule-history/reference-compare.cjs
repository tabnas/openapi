// One large document: the tree this package reads under `reading: 'spec'`
// with the rule history bounded at 3 and the limits lifted, against the
// reference parser's tree (the npm `yaml` package, core schema), node by
// node, with a mapping's keys held to their order.
//
//   node reference-compare.cjs [--heap 11000] <file>
//
// The work is done in a process of its own, and this one prints a status
// line every 15 seconds while it waits: each of the three steps can take
// a minute on a text of tens of megabytes, and says nothing as it runs.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const ROOT = path.join(__dirname, '..', '..', '..', '..')
const args = process.argv.slice(2)

if ('--work' !== args[0]) {
  const heapAt = args.indexOf('--heap')
  const heap = heapAt < 0 ? '11000' : args[heapAt + 1]
  const file = args.filter((a, i) => !a.startsWith('--') && '--heap' !== args[i - 1])[0]
  if (!file) {
    console.error('usage: node reference-compare.cjs [--heap 11000] <file>')
    process.exit(2)
  }
  const t0 = Date.now()
  let step = 'this package is reading it'
  const child = cp.spawn(process.execPath, ['--max-old-space-size=' + heap, __filename, '--work', file], { stdio: ['ignore', 'pipe', 'inherit'] })
  let rest = ''
  child.stdout.on('data', (d) => {
    rest += d
    const lines = rest.split('\n')
    rest = lines.pop()
    for (const line of lines) {
      if (line.startsWith('step: ')) step = line.slice(6)
      else console.log(line)
    }
  })
  const beat = setInterval(() => console.log(`reference-compare: ${step}, ${Math.round((Date.now() - t0) / 1000)}s so far (percentage unknown)`), 15000)
  child.on('close', (code) => {
    clearInterval(beat)
    if (rest) console.log(rest)
    if (0 !== code && 1 !== code) console.log(`reference-compare: the work ended with ${null == code ? 'a signal' : 'exit ' + code} under a heap of ${heap} MB`)
    process.exitCode = null == code ? 3 : code
  })
} else {
  const O = require(path.join(ROOT, 'ts', 'dist', 'openapi.js'))
  const YAML = require(path.join(ROOT, 'ts', 'node_modules', 'yaml'))
  const file = args[1]
  const text = fs.readFileSync(file, 'utf8')
  const done = (what, next) => {
    console.log(`${what}: ${Math.round(process.uptime())}s, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`)
    if (next) console.log('step: ' + next)
  }

  const tn = O.make({ reading: 'spec' })
  tn.options({ rule: { history: 3 } })
  const ours = O.parse(text, { reading: 'spec', fast: false, instance: tn, maxBytes: Infinity, aliasBudget: Infinity })
  done('this package read it', 'the reference is reading it')
  const doc = YAML.parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: false, merge: false })
  done('the reference read it, with ' + doc.errors.length + ' errors', 'the reference is building its tree')
  const ref = doc.toJS({ maxAliasCount: -1 })
  done('the reference built its tree', 'the two trees are being compared')

  // A difference is counted as a YAML 1.1 word where this package has
  // a boolean and the reference the word as a string: `on` read as true.
  const WORD = /^(y|yes|n|no|on|off)$/i
  let nodes = 0, diffs = 0, words = 0
  const shown = []
  const note = (at, a, b) => {
    diffs++
    if ('boolean' === typeof a && 'string' === typeof b && WORD.test(b)) words++
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
  console.log(`${path.basename(path.dirname(path.dirname(file)))}: ${nodes} nodes compared, ${diffs} differ, ${words} of them a YAML 1.1 word read as a boolean`)
  for (const s of shown) console.log('  ' + s)
  process.exitCode = diffs ? 1 : 0
}
