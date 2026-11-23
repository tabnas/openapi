/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The peer ranges of this package, held to what was measured.
//
// The plan's Decision 33 is a standing rule: each `@tabnas` peer starts at
// the first release that has what this package calls, and has no ceiling.
// `tools/peer-floors.cjs` measures that release by trial and records it in
// `tools/peer-floors.json`. This test holds `package.json` to the record,
// so that a floor is not moved without a measurement, and it holds the
// peers that are installed to the floors, so that a floor is not put
// above what a clean install gives.
//
// The tool leaves this file out of the suite it measures with: held to
// the record, every release under the last floor would fail a trial
// whether or not the package works with it. The parts of the tool that
// see to that, and to saying how far a run is, are tested at the end.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// At runtime this file is loaded from `dist-test/`.
const TS = join(__dirname, '..')
const ROOT = join(TS, '..')

const pkg = JSON.parse(readFileSync(join(TS, 'package.json'), 'utf8'))
const record: { floors: Record<string, { floor: string; under: string | null; fails: string | null }> } = JSON.parse(
  readFileSync(join(ROOT, 'tools', 'peer-floors.json'), 'utf8'),
)

const peers: Record<string, string> = pkg.peerDependencies ?? {}
const tabnas = Object.keys(peers)
  .filter((name) => name.startsWith('@tabnas/'))
  .sort()

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

describe('peer floors', () => {
  test('every @tabnas peer has a measured floor, and every floor a peer', () => {
    assert.ok(0 < tabnas.length, 'package.json names no @tabnas peer')
    assert.deepEqual(
      Object.keys(record.floors).sort(),
      tabnas.map((name) => name.slice('@tabnas/'.length)),
      'tools/peer-floors.json and the peers of package.json name different packages: run node tools/peer-floors.cjs --write',
    )
  })

  test('each range is its measured floor, with no ceiling', () => {
    for (const name of tabnas) {
      const floor = record.floors[name.slice('@tabnas/'.length)].floor
      assert.match(floor, /^\d+\.\d+\.\d+$/, `${name}: the recorded floor is no release`)
      // A caret or a ceiling would hold an install back from the latest
      // release of a peer, which is what the fleet's open ranges are for.
      assert.equal(
        peers[name],
        '>=' + floor,
        `${name} is ${peers[name]} in package.json, and its measured floor is ${floor}: ` +
          `set the range to >=${floor}, or measure again with node tools/peer-floors.cjs --write`,
      )
    }
  })

  test('each floor has the release under it, and how that one fails', () => {
    for (const [peer, entry] of Object.entries(record.floors)) {
      if (null === entry.under) {
        assert.equal(entry.fails, null, `${peer}: a floor at the first release has nothing under it`)
        continue
      }
      assert.ok(cmp(entry.under, entry.floor) < 0, `${peer}: ${entry.under} is not under ${entry.floor}`)
      assert.ok('string' === typeof entry.fails && '' !== entry.fails, `${peer}: no reason recorded for ${entry.under}`)
    }
  })

  test('the peers installed are at or above their floors', () => {
    for (const name of tabnas) {
      const floor = record.floors[name.slice('@tabnas/'.length)].floor
      const have = JSON.parse(readFileSync(join(TS, 'node_modules', name, 'package.json'), 'utf8')).version
      assert.ok(
        0 <= cmp(have.replace(/[-+].*$/, ''), floor),
        `${name} ${have} is installed, under the floor ${floor} that package.json declares`,
      )
    }
  })
})

// The tool's own parts. Requiring it runs nothing.
type Ran = { status: number | null; stdout: string; stderr: string }
type Tool = {
  RECORD_TEST: string
  trialTests: (names: string[]) => string[]
  mostTrials: (releases: number) => number
  during: (what: () => string, cmd: string, args: string[], opts?: object, beatMs?: number, say?: (line: string) => void) => Promise<Ran>
  failingTests: (out: string, most?: number) => string
}
const tool: Tool = require(join(ROOT, 'tools', 'peer-floors.cjs'))

describe('the peer floors tool', () => {
  test('a trial runs every test of the suite but this one', () => {
    // This file is the one that holds the peers to the record.
    assert.equal(basename(__filename), tool.RECORD_TEST)
    const built = readdirSync(__dirname)
    const all = built.filter((name) => name.endsWith('.test.js'))
    const tests = tool.trialTests(built)
    assert.equal(tests.includes(tool.RECORD_TEST), false)
    assert.deepEqual(tests, all.filter((name) => tool.RECORD_TEST !== name).sort())
    assert.ok(20 < tests.length, 'a trial would run next to nothing')
    assert.deepEqual(tool.trialTests(['b.test.js', 'a.test.js', 'a.test.js.map', 'helper.js', tool.RECORD_TEST]), ['a.test.js', 'b.test.js'])
  })

  test('the most trials a search over releases takes', () => {
    // The latest, the first, and a halving of what is between them.
    const search = (releases: number, floor: number) => {
      const seen = new Set<number>()
      const passes = (i: number) => (seen.add(i), floor <= i)
      if (!passes(releases - 1)) return seen.size
      let lo = 0
      let hi = releases - 1
      if (passes(0)) hi = 0
      else
        while (1 < hi - lo) {
          const mid = (lo + hi) >> 1
          if (passes(mid)) hi = mid
          else lo = mid
        }
      return seen.size
    }
    for (let releases = 1; releases <= 70; releases++) {
      let worst = 0
      for (let floor = 0; floor <= releases; floor++) worst = Math.max(worst, search(releases, floor))
      assert.equal(tool.mostTrials(releases), worst, `${releases} releases`)
    }
  })

  test('a failed trial names the tests that failed', () => {
    const out = [
      '▶ the file loader',
      '  ✖ a link is followed, and judged by where it leads (4.584653ms)',
      '✖ the file loader (136.773568ms)',
      'ℹ tests 958',
      'ℹ pass 955',
      'ℹ fail 3',
      '',
      '✖ failing tests:',
      '',
      'test at dist-test/loaders.test.js:105:3',
      '✖ a link is followed, and judged by where it leads (4.584653ms)',
      '  Error [ResolveError]: load: "file:///tmp/x" is outside the directory this loader reads',
      '',
      'test at dist-test/history.test.js:1:1',
      '✖ dist-test/history.test.js (97.772908ms)',
      '',
      'test at dist-test/hostile.test.js:40:3',
      '✖ at the default limit, a text past the steps of a parser that keeps every rule is read by the other (22160.018691ms)',
    ].join('\n')
    assert.equal(
      tool.failingTests(out),
      'a link is followed, and judged by where it leads; dist-test/history.test.js; and 1 more',
    )
    assert.equal(tool.failingTests(out, 3).split('; ')[2], 'at the default limit, a text past the steps of a parser t...')
    // A suite that was stopped has no list to read.
    assert.equal(tool.failingTests('ℹ tests 3\nℹ pass 3\n'), '')
  })

  test('a command says that it is running while it runs, and one that does not end is stopped', async () => {
    const lines: string[] = []
    const waited = await tool.during(() => 'trial 1 of at most 4: the suite', process.execPath, ['-e', 'setTimeout(() => console.log("done"), 400)'], {}, 50, (line) =>
      lines.push(line),
    )
    assert.equal(waited.status, 0)
    assert.equal(waited.stdout, 'done\n')
    assert.ok(3 <= lines.length, `${lines.length} lines in 400 ms at one each 50 ms`)
    assert.match(lines[0], /^ {3}trial 1 of at most 4: the suite, \d+s$/)
    // Nothing more is said once it has ended.
    const said = lines.length
    await new Promise((done) => setTimeout(done, 120))
    assert.equal(lines.length, said)

    const failed = await tool.during(() => '', process.execPath, ['-e', 'console.error("no"); process.exit(3)'], {}, 1000, () => {})
    assert.equal(failed.status, 3)
    assert.equal(failed.stderr, 'no\n')
    const stopped = await tool.during(() => '', process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 150 }, 1000, () => {})
    assert.equal(stopped.status, null)
    const absent = await tool.during(() => '', 'no-such-command-as-this', [], {}, 1000, () => {})
    assert.equal(absent.status, null)
  })
})
