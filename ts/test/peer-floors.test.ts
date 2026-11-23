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

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
