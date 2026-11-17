// The engine's rule history, bounded, on this package's parser.
//
//   node history.cjs equal [--bound 3] [--max-kb 2048]
//       every YAML document of the corpus up to a size: is the tree read
//       under the bound the tree read without one? One process.
//   node history.cjs cost [--bound 3] <file>...
//       time and peak memory of each file, unbounded and bounded, a
//       process for each reading, and whether the two trees are the same.
//   node history.cjs one <bound|none> <file>
//       one reading, as `cost` runs it.
//
// The corpus is the sweep's: `node tools/corpus/fetch.cjs` puts it in
// .corpus/src. Every reading is `reading: 'spec'` on the grammar path with
// the limits on size and aliases lifted, so that what is measured is the
// parse and not a refusal.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto')
const ROOT = path.join(__dirname, '..', '..', '..', '..')
const O = require(path.join(ROOT, 'ts', 'dist', 'openapi.js'))
const SRC = path.join(ROOT, '.corpus', 'src')
const args = process.argv.slice(2)
const mode = args[0]
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1] }
const canon = (v) => JSON.stringify(v, (k, x) => 'number' === typeof x && !Number.isFinite(x) ? '@@' + x : x)

function parserFor(bound) {
  const tn = O.make({ reading: 'spec' })
  if ('none' !== bound) tn.options({ rule: { history: +bound } })
  return tn
}

function read(tn, text) {
  try {
    return canon(O.parse(text, { reading: 'spec', fast: false, instance: tn, maxBytes: Infinity, aliasBudget: Infinity }))
  } catch (e) {
    return 'ERR ' + (e.code || e.message)
  }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.ya?ml$/i.test(e.name)) out.push(p)
  }
  return out
}

if ('one' === mode) {
  const [, bound, file] = args
  const text = fs.readFileSync(file, 'utf8')
  const tn = parserFor(bound)
  const t0 = process.hrtime.bigint()
  const got = read(tn, text)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  process.stdout.write(JSON.stringify({
    ms: Math.round(ms),
    rssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    bytes: Buffer.byteLength(text),
    err: got.startsWith('ERR ') ? got : null,
    hash: crypto.createHash('sha1').update(got).digest('hex'),
  }) + '\n')
} else if ('cost' === mode) {
  const bound = opt('--bound', '3')
  const files = args.slice(1).filter((a, i, all) => !a.startsWith('--') && '--bound' !== all[i - 1])
  console.log('file\tbytes\tunbounded ms\tunbounded MB\tbounded ms\tbounded MB\tsame tree')
  for (const f of files) {
    const run = (b) => JSON.parse(cp.execFileSync(process.execPath, ['--max-old-space-size=9000', __filename, 'one', b, f], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop())
    const a = run('none'), b = run(bound)
    console.log([path.relative(SRC, path.resolve(f)), a.bytes, a.ms, a.rssMB, b.ms, b.rssMB, a.hash === b.hash ? 'yes' : 'NO' + (a.err || b.err ? ' ' + (a.err || '') + '/' + (b.err || '') : '')].join('\t'))
  }
} else if ('equal' === mode) {
  const bound = opt('--bound', '3'), maxKb = +opt('--max-kb', '2048')
  const files = walk(SRC, []).sort()
  const plain = parserFor('none'), bounded = parserFor(bound)
  let n = 0, same = 0, skipped = 0, t = Date.now()
  const t0 = Date.now()
  const diff = []
  for (const f of files) {
    n++
    if (fs.statSync(f).size > maxKb * 1024) { skipped++; continue }
    const text = fs.readFileSync(f, 'utf8')
    const a = read(plain, text), b = read(bounded, text)
    if (a === b) same++; else diff.push(path.relative(SRC, f))
    if (Date.now() - t > 15000) {
      t = Date.now()
      console.log(`history equal: ${n} of ${files.length} (${Math.round(100 * n / files.length)}%), ${Math.round((Date.now() - t0) / 1000)}s, ${diff.length} differ`)
    }
  }
  console.log(`history equal: bound ${bound}: ${same} of ${n - skipped} YAML documents read to the same tree; ${skipped} over ${maxKb} KB left for the cost run`)
  for (const d of diff.slice(0, 40)) console.log('  differs: ' + d)
  process.exitCode = diff.length ? 1 : 0
} else {
  console.error('usage: node history.cjs equal|cost|one ... (see the head of this file)')
  process.exitCode = 2
}
