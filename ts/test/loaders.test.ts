/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The loaders `resolveAll` can be given: what each reads, and what it
// refuses. A description names whatever documents its author chose, so
// the tests that matter here are the ones for what a loader must not
// read.

import { describe, test } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse, resolveAll, ResolveError } from '../dist/openapi'
import { fileLoader, httpLoader, isPublicAddress } from '../dist/loaders'

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

describe('the HTTP loader', () => {
  // Two servers on this machine, each counting what it is asked. A test
  // sets what a path answers with.
  type Handler = (req: IncomingMessage, res: ServerResponse) => void
  const routes: Record<string, Handler> = {}
  const asked: string[] = []
  const seen: Record<string, IncomingMessage['headers']> = {}
  const servers: Server[] = []
  const origins: string[] = []
  const hosts: string[] = []

  test.before(async () => {
    for (const name of ['a', 'b']) {
      const server = createServer((req, res) => {
        asked.push(name + req.url)
        seen[name + req.url] = req.headers
        const route = routes[name + req.url]
        if (undefined === route) {
          res.statusCode = 404
          res.end('nothing here')
        } else route(req, res)
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      const port = (server.address() as AddressInfo).port
      servers.push(server)
      hosts.push('127.0.0.1:' + port)
      origins.push('http://127.0.0.1:' + port)
    }
  })
  test.after(() => {
    for (const server of servers) {
      server.closeAllConnections()
      server.close()
    }
  })
  test.beforeEach(() => {
    asked.length = 0
    for (const k of Object.keys(routes)) delete routes[k]
  })

  const text = (bytes: unknown) => new TextDecoder().decode(bytes as Uint8Array)
  const give = (body: string): Handler => (_req, res) => res.end(body)
  const to = (location: string): Handler => (_req, res) => {
    res.statusCode = 302
    res.setHeader('location', location)
    res.end()
  }
  // A loader for the first server alone, over plain HTTP on this machine.
  const local = (more: object = {}) => httpLoader({ hosts: [hosts[0]], schemes: ['http'], privateAddresses: true, ...more })

  test('it reads a document from a host in its list, and has none for one that is not there', async () => {
    routes['a/api/Pet.yaml'] = give('type: object\n')
    const load = local()
    assert.equal(text(await load(origins[0] + '/api/Pet.yaml')), 'type: object\n')
    assert.equal(await load(origins[0] + '/api/Missing.yaml'), undefined)
    routes['a/gone'] = (_req, res) => ((res.statusCode = 410), res.end())
    assert.equal(await load(origins[0] + '/gone'), undefined)
    // A document that is not over HTTP is not this loader's to have.
    assert.equal(await load('file:///etc/passwd'), undefined)
    assert.equal(await load('urn:Pet.yaml'), undefined)
    // Any other answer is a failure, and says so.
    routes['a/broken'] = (_req, res) => ((res.statusCode = 500), res.end('no'))
    await assert.rejects(async () => load(origins[0] + '/broken'), (e: any) => refused(e) && /answered 500/.test(e.message))
  })

  test('it refuses a host or a scheme that is not in its list, and asks nothing', async () => {
    routes['b/api/Pet.yaml'] = give('type: object\n')
    await assert.rejects(async () => local()(origins[1] + '/api/Pet.yaml'), refused)
    // The list is of hosts with their ports, and https is the scheme
    // unless the caller says.
    await assert.rejects(async () => httpLoader({ hosts: ['127.0.0.1'], schemes: ['http'], privateAddresses: true })(origins[0] + '/x'), refused)
    await assert.rejects(async () => httpLoader({ hosts: [hosts[0]], privateAddresses: true })(origins[0] + '/x'), refused)
    await assert.rejects(async () => local()(origins[0].replace('http://', 'http://user:secret@') + '/x'), refused)
    assert.deepEqual(asked, [])
    assert.throws(() => httpLoader({} as any), TypeError)
    assert.throws(() => httpLoader({ hosts: [hosts[0]], schemes: ['ftp' as any] }), TypeError)
    assert.throws(() => httpLoader({ hosts: [hosts[0]], maxBytes: -1 }), TypeError)
  })

  test('a redirect is followed, and judged again where it leads', async () => {
    routes['a/final'] = give('type: string\n')
    routes['a/moved'] = to('/final')
    routes['a/away'] = to(origins[1] + '/secret')
    routes['b/secret'] = give('not for this loader\n')
    routes['a/loop'] = to('/loop')
    const load = local()
    assert.equal(text(await load(origins[0] + '/moved')), 'type: string\n')
    await assert.rejects(async () => load(origins[0] + '/away'), (e: any) => refused(e) && /a host this loader does not read/.test(e.message))
    assert.equal(asked.includes('b/secret'), false)
    await assert.rejects(async () => load(origins[0] + '/loop'), (e: any) => refused(e) && /redirects more than 5 times/.test(e.message))
    assert.equal(asked.filter((a) => 'a/loop' === a).length, 6)
    // With both hosts in the list the redirect is followed.
    const both = httpLoader({ hosts, schemes: ['http'], privateAddresses: true })
    assert.equal(text(await both(origins[0] + '/away')), 'not for this loader\n')
  })

  test('headers go to the origin they were given for, and to no other', async () => {
    routes['a/start'] = to(origins[1] + '/end')
    routes['b/end'] = give('type: string\n')
    const load = httpLoader({
      hosts,
      schemes: ['http'],
      privateAddresses: true,
      headers: { [origins[0]]: { authorization: 'Bearer for-a' } },
    })
    assert.equal(text(await load(origins[0] + '/start')), 'type: string\n')
    assert.equal(seen['a/start'].authorization, 'Bearer for-a')
    assert.equal(seen['b/end'].authorization, undefined)
  })

  test('a document past its size, or its time, is refused', async () => {
    routes['a/big'] = give('x'.repeat(5000))
    routes['a/stream'] = (_req, res) => {
      res.write('x'.repeat(3000))
      setTimeout(() => res.end('x'.repeat(3000)), 10)
    }
    await assert.rejects(async () => local({ maxBytes: 4000 })(origins[0] + '/big'), (e: any) => refused(e) && /is 5000 bytes/.test(e.message))
    await assert.rejects(async () => local({ maxBytes: 4000 })(origins[0] + '/stream'), (e: any) => refused(e) && /more than the 4000 bytes/.test(e.message))
    assert.equal(text(await local({ maxBytes: 5000 })(origins[0] + '/big')).length, 5000)

    routes['a/slow'] = (_req, res) => void setTimeout(() => res.end('late\n'), 2000)
    await assert.rejects(async () => local({ timeoutMs: 100 })(origins[0] + '/slow'), (e: any) => refused(e) && /took more than 100 ms/.test(e.message))
    const stop = new AbortController()
    const waiting = local({ signal: stop.signal })(origins[0] + '/slow') as Promise<unknown>
    setTimeout(() => stop.abort(), 50)
    await assert.rejects(waiting, (e: any) => refused(e) && /was stopped/.test(e.message))
  })

  test('a host that is at no public address is refused, and nothing is asked of it', async () => {
    routes['a/api/Pet.yaml'] = give('type: object\n')
    // This machine's own address, by its number and by a name.
    await assert.rejects(async () => httpLoader({ hosts: [hosts[0]], schemes: ['http'] })(origins[0] + '/api/Pet.yaml'), (e: any) => refused(e) && /no public address/.test(e.message))
    const named = (addresses: string[]) =>
      httpLoader({
        hosts: ['api.example.com'],
        schemes: ['http'],
        lookup: async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      })
    for (const inside of [['10.0.0.5'], ['169.254.169.254'], ['::1'], ['fd00::1'], ['::ffff:127.0.0.1'], ['93.184.216.34', '192.168.1.1']]) {
      await assert.rejects(async () => named(inside)('http://api.example.com/x'), (e: any) => refused(e) && /no public address/.test(e.message), inside.join())
    }
    await assert.rejects(async () => named([])('http://api.example.com/x'), refused)
    assert.deepEqual(asked, [])
  })

  test('which addresses are public', () => {
    const open = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '192.0.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808']
    const closed = [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9',
      '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
      '::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1',
      'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '2002:a00:1::1',
      'fe80::1%eth0', 'not an address', '', '1.2.3', '1.2.3.4.5', '256.1.1.1', '::g', '1::2::3', '1:2:3:4:5:6:7:8:9',
    ]
    for (const a of open) assert.equal(isPublicAddress(a), true, a)
    for (const a of closed) assert.equal(isPublicAddress(a), false, a)
  })

  test('it keeps what it read, unless told not to, and asks again for what failed', async () => {
    routes['a/api/Pet.yaml'] = give('type: object\n')
    const keeping = local()
    await keeping(origins[0] + '/api/Pet.yaml')
    await keeping(origins[0] + '/api/Pet.yaml')
    assert.equal(asked.length, 1)
    const asking = local({ cache: false })
    await asking(origins[0] + '/api/Pet.yaml')
    await asking(origins[0] + '/api/Pet.yaml')
    assert.equal(asked.length, 3)
    routes['a/flaky'] = (_req, res) => ((res.statusCode = 503), res.end())
    await assert.rejects(async () => keeping(origins[0] + '/flaky'), refused)
    routes['a/flaky'] = give('type: string\n')
    assert.equal(text(await keeping(origins[0] + '/flaky')), 'type: string\n')
  })

  test('resolveAll reads a description over HTTP with it', async () => {
    routes['a/api/schemas/Pet.yaml'] = give('type: object\nproperties:\n  owner: {$ref: "Owner.json"}\n')
    routes['a/api/schemas/Owner.json'] = give('{"type":"string"}')
    const raw = parse('openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Pet: {$ref: schemas/Pet.yaml}\n    Far: {$ref: "' + origins[1] + '/far.yaml"}\n')
    const r = await resolveAll(raw, { retrievalUri: origins[0] + '/api/openapi.yaml', load: local() }).catch((e) => e)
    // The second host is not in the list, so the run is stopped there.
    assert.ok(refused(r), String(r))
    const near = parse('openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    Pet: {$ref: schemas/Pet.yaml}\n')
    const ok = await resolveAll(near, { retrievalUri: origins[0] + '/api/openapi.yaml', load: local() })
    assert.deepEqual(JSON.parse(JSON.stringify(ok.tree.components.schemas.Pet)), { type: 'object', properties: { owner: { type: 'string' } } })
    assert.deepEqual(ok.documents, [origins[0] + '/api/schemas/Pet.yaml', origins[0] + '/api/schemas/Owner.json'])
  })
})
