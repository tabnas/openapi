// The engine's rule history, bounded, on this package's parser.
//
//   node history.cjs equal [--bound 3] [--max-kb 2048]
//       every YAML document of the corpus up to a size: is the tree read
//       under the bound the tree read without one? One process, and a
//       status line every 15 seconds.
//   node history.cjs cost [--bound 3] [--heap 4096] <file>...
//       the time and the peak memory of each file's parse, unbounded and
//       bounded, a process for each reading, and whether the two trees
//       are the same. A status line every 15 seconds while a reading
//       runs.
//   node history.cjs one <bound|none> <file>
//       one reading, as `cost` runs it: a line of JSON.
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
const VALUED = ['--bound', '--heap', '--max-kb']
const canon = (v) => JSON.stringify(v, (k, x) => 'number' === typeof x && !Number.isFinite(x) ? '@@' + x : x)

function parserFor(bound) {
  const tn = O.make({ reading: 'spec' })
  if ('none' !== bound) tn.options({ rule: { history: +bound } })
  return tn
}

// A reading: the tree, or the code of the refusal.
function read(tn, text) {
  try {
    return { tree: O.parse(text, { reading: 'spec', fast: false, instance: tn, maxBytes: Infinity, aliasBudget: Infinity }) }
  } catch (e) {
    return { refused: String(e.code || e.message) }
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

// One reading in a process of its own, with a status line every 15
// seconds while it runs: a large text takes a minute, and says nothing.
function measure(bound, file, heap, label) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = cp.spawn(process.execPath, ['--max-old-space-size=' + heap, __filename, 'one', bound, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', () => {})
    const beat = setInterval(() => console.error(`history cost: ${label}, ${Math.round((Date.now() - t0) / 1000)}s so far (percentage unknown)`), 15000)
    child.on('close', (code) => {
      clearInterval(beat)
      const line = out.trim().split('\n').pop()
      let got = null
      try { got = JSON.parse(line) } catch {}
      resolve(got && 0 === code ? got : { failed: 'the process ended with ' + (null == code ? 'a signal' : 'exit ' + code) + ' under a heap of ' + heap + ' MB' })
    })
  })
}

async function main() {
  if ('one' === mode) {
    const [, bound, file] = args
    const text = fs.readFileSync(file, 'utf8')
    const tn = parserFor(bound)
    // The parse alone: the clock and the peak are read before the tree
    // is serialised for its hash.
    const t0 = process.hrtime.bigint()
    const got = read(tn, text)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const rssMB = Math.round(process.resourceUsage().maxRSS / 1024)
    process.stdout.write(JSON.stringify({
      ms: Math.round(ms),
      rssMB,
      bytes: Buffer.byteLength(text),
      refused: got.refused || null,
      hash: got.refused ? null : crypto.createHash('sha1').update(canon(got.tree)).digest('hex'),
    }) + '\n')
  } else if ('cost' === mode) {
    const bound = opt('--bound', '3'), heap = opt('--heap', '4096')
    const files = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !VALUED.includes(all[i - 1]))
    const cell = (r) => r.failed ? ['not read', r.failed] : r.refused ? ['refused', r.refused] : [r.ms, r.rssMB]
    console.log('file\tbytes\tunbounded ms\tunbounded MB\tbounded ms\tbounded MB\tsame tree')
    let k = 0
    for (const f of files) {
      k++
      const name = path.relative(SRC, path.resolve(f))
      const a = await measure('none', f, heap, `${name} (${k} of ${files.length}), unbounded`)
      const b = await measure(bound, f, heap, `${name} (${k} of ${files.length}), bounded at ${bound}`)
      const same = a.hash && b.hash ? (a.hash === b.hash ? 'yes' : 'NO') : 'not compared'
      console.log([name, a.bytes ?? b.bytes ?? '', ...cell(a), ...cell(b), same].join('\t'))
      if ('NO' === same) process.exitCode = 1
    }
  } else if ('equal' === mode) {
    const bound = opt('--bound', '3'), maxKb = +opt('--max-kb', '2048')
    const files = walk(SRC, []).sort()
    const plain = parserFor('none'), bounded = parserFor(bound)
    let n = 0, sameTree = 0, skipped = 0, t = Date.now()
    const t0 = Date.now()
    const differ = [], refusedAlike = []
    for (const f of files) {
      n++
      if (fs.statSync(f).size > maxKb * 1024) { skipped++; continue }
      const text = fs.readFileSync(f, 'utf8')
      const a = read(plain, text), b = read(bounded, text)
      const name = path.relative(SRC, f)
      // A refusal is no tree: two alike are counted apart from two trees
      // alike, and one against a tree is a difference.
      if (a.refused || b.refused) {
        if (a.refused === b.refused) refusedAlike.push(name + ' (' + a.refused + ')')
        else differ.push(name + ': ' + (a.refused ? 'refused ' + a.refused : 'a tree') + ' unbounded, ' + (b.refused ? 'refused ' + b.refused : 'a tree') + ' bounded')
      } else if (canon(a.tree) === canon(b.tree)) sameTree++
      else differ.push(name + ': two trees')
      if (Date.now() - t > 15000) {
        t = Date.now()
        console.log(`history equal: ${n} of ${files.length} (${Math.round(100 * n / files.length)}%), ${Math.round((Date.now() - t0) / 1000)}s, ${differ.length} differ`)
      }
    }
    console.log(`history equal: bound ${bound}: of ${n - skipped} YAML documents up to ${maxKb} KB, ${sameTree} read to the same tree, ${refusedAlike.length} are refused alike, ${differ.length} differ; ${skipped} larger are left for the cost run`)
    for (const r of refusedAlike.slice(0, 40)) console.log('  refused alike: ' + r)
    for (const d of differ.slice(0, 40)) console.log('  differs: ' + d)
    process.exitCode = differ.length ? 1 : 0
  } else {
    console.error('usage: node history.cjs equal|cost|one ... (see the head of this file)')
    process.exitCode = 2
  }
}

main()
