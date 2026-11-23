/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The loaders `resolveAll` can be given: what each reads, and what it
// refuses. A description names whatever documents its author chose, so
// the tests that matter here are the ones for what a loader must not
// read.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse, resolveAll, ResolveError } from '../dist/openapi'
import { fileLoader } from '../dist/loaders'

const refused = (e: any) => e instanceof ResolveError && 'openapi_load' === e.code

describe('the loaders are apart from the rest', () => {
  // At runtime this file is in ts/dist-test.
  const TS = join(__dirname, '..')

  test('no other module of the package names a Node module, or one of the runtime\'s globals', () => {
    for (const file of readdirSync(join(TS, 'src')).filter((f) => f.endsWith('.ts') && 'loaders.ts' !== f)) {
      const source = readFileSync(join(TS, 'src', file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n')
      for (const [what, re] of [
        ['a Node module', /from 'node:|require\(/],
        ['process', /\bprocess\./],
        ['Buffer', /\bBuffer\b/],
        ['fetch', /\bfetch\(/],
      ] as [string, RegExp][]) {
        assert.equal(re.test(source), false, `ts/src/${file} uses ${what}`)
      }
    }
  })

  test('the main module does not load them', () => {
    const script = `
      require(${JSON.stringify(join(TS, 'dist', 'openapi.js'))})
      console.log(Object.keys(require.cache).filter((f) => /loaders\\.js$/.test(f)).length)
    `
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout.trim(), '0')
  })
})

describe('the file loader', () => {
  // A directory to read under, with one beside it that is out of bounds.
  const base = mkdtempSync(join(tmpdir(), 'openapi-loaders-'))
  const root = join(base, 'api')
  const outside = join(base, 'outside')
  mkdirSync(join(root, 'schemas'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'openapi.yaml'), 'openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Pet: {$ref: schemas/Pet.yaml}\n')
  writeFileSync(join(root, 'schemas', 'Pet.yaml'), 'type: object\nproperties:\n  owner: {$ref: Owner.json}\n')
  writeFileSync(join(root, 'schemas', 'Owner.json'), '{"type":"string"}')
  writeFileSync(join(outside, 'secret.yaml'), 'type: string\ndescription: not for reading\n')
  // Links, where the platform lets a test make them.
  let links = true
  try {
    symlinkSync(join(root, 'schemas'), join(root, 'inside'), 'dir')
    symlinkSync(outside, join(root, 'way-out'), 'dir')
    symlinkSync(join(outside, 'secret.yaml'), join(root, 'schemas', 'borrowed.yaml'), 'file')
    symlinkSync(root, join(base, 'alias'), 'dir')
  } catch {
    links = false
  }
  test.after(() => rmSync(base, { recursive: true, force: true }))

  const uri = (...parts: string[]) => pathToFileURL(join(...parts)).href
  const text = (bytes: unknown) => new TextDecoder().decode(bytes as Uint8Array)

  test('it reads a file under its directory, and has none for anything else it may look for', async () => {
    const load = fileLoader({ root })
    assert.equal(text(await load(uri(root, 'schemas', 'Owner.json'))), '{"type":"string"}')
    assert.ok((await load(uri(root, 'schemas', 'Pet.yaml'))) instanceof Uint8Array)
    assert.equal(await load(uri(root, 'schemas', 'Missing.yaml')), undefined)
    assert.equal(await load(uri(root, 'schemas')), undefined)
    assert.equal(await load(uri(root, 'openapi.yaml', 'below-a-file.yaml')), undefined)
    // A document that is no file is not this loader's to have.
    assert.equal(await load('https://example.com/api/Pet.yaml'), undefined)
    assert.equal(await load('urn:Pet.yaml'), undefined)
  })

  test('it refuses a file outside its directory, however the path is written', async () => {
    const load = fileLoader({ root })
    await assert.rejects(async () => load(uri(outside, 'secret.yaml')), refused)
    await assert.rejects(async () => load(pathToFileURL(root).href + '/../outside/secret.yaml'), refused)
    await assert.rejects(async () => load(pathToFileURL(root).href + '/schemas/%2e%2e/%2e%2e/outside/secret.yaml'), refused)
    await assert.rejects(async () => load(uri(base)), refused)
    // Refused whether or not it is there: nothing outside is looked for.
    await assert.rejects(async () => load(uri(outside, 'nothing.yaml')), refused)
    await assert.rejects(async () => load('file://elsewhere.example/api/openapi.yaml'), refused)
  })

  test('a link is followed, and judged by where it leads', { skip: !links }, async () => {
    const load = fileLoader({ root })
    assert.equal(text(await load(uri(root, 'inside', 'Owner.json'))), '{"type":"string"}')
    await assert.rejects(async () => load(uri(root, 'way-out', 'secret.yaml')), refused)
    await assert.rejects(async () => load(uri(root, 'schemas', 'borrowed.yaml')), refused)
    // The directory may itself be given through a link.
    const linked = fileLoader({ root: join(base, 'alias') })
    assert.equal(text(await linked(uri(base, 'alias', 'schemas', 'Owner.json'))), '{"type":"string"}')
    assert.equal(text(await linked(uri(root, 'schemas', 'Owner.json'))), '{"type":"string"}')
    await assert.rejects(async () => linked(uri(base, 'alias', 'way-out', 'secret.yaml')), refused)
  })

  test('a file past the size it reads is refused before it is read', async () => {
    await assert.rejects(async () => fileLoader({ root, maxBytes: 8 })(uri(root, 'schemas', 'Owner.json')), refused)
    assert.equal(text(await fileLoader({ root, maxBytes: 17 })(uri(root, 'schemas', 'Owner.json'))), '{"type":"string"}')
    assert.throws(() => fileLoader({ root: '' }), TypeError)
    assert.throws(() => fileLoader({} as any), TypeError)
    assert.throws(() => fileLoader({ root, maxBytes: -1 }), TypeError)
  })

  test('resolveAll reads a description from disk with it, and is stopped at the directory', async () => {
    const entry = join(root, 'openapi.yaml')
    const raw = parse(new TextEncoder().encode('openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Pet: {$ref: schemas/Pet.yaml}\n'))
    const r = await resolveAll(raw, { retrievalUri: pathToFileURL(entry).href, load: fileLoader({ root }) })
    assert.deepEqual(JSON.parse(JSON.stringify(r.tree.components.schemas.Pet)), { type: 'object', properties: { owner: { type: 'string' } } })
    assert.deepEqual(r.documents, [uri(root, 'schemas', 'Pet.yaml'), uri(root, 'schemas', 'Owner.json')])
    assert.deepEqual(r.unresolved, [])

    const reaching = parse('openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Secret: {$ref: ../outside/secret.yaml}\n')
    await assert.rejects(() => resolveAll(reaching, { retrievalUri: pathToFileURL(entry).href, load: fileLoader({ root }) }), refused)
  })
})
