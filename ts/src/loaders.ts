/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The loaders `resolveAll` can be given. `resolveAll` reads nothing by
// itself: its `load` is the caller's, and a description names whatever
// documents its author chose. Each loader here is made by the caller,
// with the bound on what it may reach stated when it is made, and none
// is on by default. The main module does not load this one, so a caller
// who makes no loader has no file or network code in reach.
//
//   fileLoader   files under one directory, and nothing outside it
//   httpLoader   documents on the hosts the caller lists, and no others
//
// A loader gives a document's bytes, or `undefined` for a document it
// does not have, which leaves the references to it as written. What it
// is not allowed to reach it refuses, with `openapi_load`: a description
// that names such a document is told so, not passed over in silence.
//
// The plan is docs/design/typescript-plan.md, step T4 and Decision 31.

// This is the one module of the package that needs Node. The rest is
// built with no types of a runtime, and ts/test/loaders.test.ts holds it
// to that: no other module names a Node module, and the main one does
// not load this.
/// <reference types="node" />

import { promises as dns } from 'node:dns'
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { isIP } from 'node:net'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ResolveError } from './resolve'
import type { Loader } from './resolve'

type FileLoaderOptions = {
  // The directory the loader reads under. A file outside it is refused,
  // and where a file is, is judged once every symbolic link on its path
  // has been followed: a link under the directory that leads out of it
  // is refused as a path out of it is.
  root: string
  // The largest file it reads, in bytes. Default 128 MiB, the most
  // `parse` reads by default. A larger file is refused before it is
  // read.
  maxBytes?: number
}

const quoted = (v: unknown) => JSON.stringify(String(v))

const refuse = (message: string, uri: string): never => {
  throw new ResolveError('openapi_load', 'load: ' + message, uri)
}

// Whether `path` is `dir` or under it, both absolute and with no link
// left to follow.
function under(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return '' === rel || (!rel.startsWith('..' + sep) && '..' !== rel && !isAbsolute(rel))
}

// A loader of files under one directory. It reads a document named by a
// `file:` URI, and has none for any other URI.
function fileLoader(options: FileLoaderOptions): Loader {
  if (null == options || 'string' !== typeof options.root || '' === options.root) {
    throw new TypeError('fileLoader: root must be a directory, not ' + quoted(options?.root))
  }
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024
  if (!(('number' === typeof maxBytes && 0 <= maxBytes) || Infinity === maxBytes)) {
    throw new TypeError('fileLoader: maxBytes must be a number of bytes, not ' + quoted(maxBytes))
  }
  const given = resolvePath(options.root)
  // The directory as it is once its own links are followed, found when
  // the first document is asked for.
  let root: Promise<string> | undefined

  return async (uri: string) => {
    if (!/^file:/i.test(uri)) return undefined
    let path: string
    try {
      path = fileURLToPath(uri)
    } catch {
      // A `file:` URI with a host, or one this platform has no path for.
      return refuse(`${quoted(uri)} names no file on this machine`, uri)
    }
    root ??= fs.realpath(given)
    const dir = await root
    // Judged as written first, so that nothing outside the directory is
    // so much as looked for.
    if (!under(given, resolvePath(path)) && !under(dir, resolvePath(path))) {
      return refuse(`${quoted(uri)} is outside the directory this loader reads`, uri)
    }
    let real: string
    try {
      real = await fs.realpath(path)
    } catch (err: any) {
      if ('ENOENT' === err?.code || 'ENOTDIR' === err?.code) return undefined
      throw err
    }
    if (!under(dir, real)) {
      return refuse(`${quoted(uri)} leads, through a link, outside the directory this loader reads`, uri)
    }
    const stat = await fs.stat(real)
    if (!stat.isFile()) return undefined
    if (maxBytes < stat.size) {
      return refuse(`${quoted(uri)} is ${stat.size} bytes, and this loader reads ${maxBytes} at most`, uri)
    }
    return new Uint8Array(await fs.readFile(real))
  }
}

type Address = { address: string; family: number }

type HttpLoaderOptions = {
  // The hosts the loader reads from, each as a URL writes it, in lower
  // case, with its port where that is not the scheme's own:
  // `api.example.com`, `localhost:8080`. A document on any other host is
  // refused, and so is one a redirect leads to.
  hosts: string[]
  // The schemes it uses. Default `['https']`.
  schemes?: ('https' | 'http')[]
  // Whether a host may be at an address that is not a public one: a
  // loopback, private or link-local address, or one of the ranges kept
  // for other uses. Default false. A host name in the list can otherwise
  // be pointed, by whoever answers for its name, at the machine itself
  // or at the network it is on.
  privateAddresses?: boolean
  // The largest document it reads, in bytes. Default 16 MiB.
  maxBytes?: number
  // The longest one document may take, redirects included. Default
  // 10,000 milliseconds.
  timeoutMs?: number
  // The most redirects it follows for one document. Default 5.
  maxRedirects?: number
  // Stops a request under way.
  signal?: AbortSignal
  // Headers to send, by origin: `{ 'https://api.example.com': { authorization: '...' } }`.
  // Each is sent to that origin alone, a redirect to another included.
  headers?: Record<string, Record<string, string>>
  // False to ask again each time. By default the loader keeps what it
  // read, for as long as the loader is kept.
  cache?: boolean
  // How a host name is turned into addresses. Default: the system's.
  lookup?: (host: string) => Promise<Address[]>
}

// An IPv4 address as four numbers, or undefined.
function quad(text: string): number[] | undefined {
  const parts = text.split('.')
  if (4 !== parts.length) return undefined
  const out = parts.map((p) => (/^[0-9]{1,3}$/.test(p) ? Number(p) : 256))
  return out.every((n) => n < 256) ? out : undefined
}

function publicV4([a, b, c]: number[]): boolean {
  if (0 === a || 10 === a || 127 === a) return false
  if (100 === a && 64 <= b && b < 128) return false
  if (169 === a && 254 === b) return false
  if (172 === a && 16 <= b && b < 32) return false
  if (192 === a && 0 === b && (0 === c || 2 === c)) return false
  if (192 === a && 88 === b && 99 === c) return false
  if (192 === a && 168 === b) return false
  if (198 === a && (18 === b || 19 === b)) return false
  if (198 === a && 51 === b && 100 === c) return false
  if (203 === a && 0 === b && 113 === c) return false
  return a < 224
}

// An IPv6 address as eight numbers, or undefined. A dotted quad at its
// end counts as its last two.
function hextets(text: string): number[] | undefined {
  let rest = text.replace(/%.*$/, '')
  let tail: number[] = []
  const dotted = /(^|:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/.exec(rest)
  if (null !== dotted) {
    const q = quad(dotted[2])
    if (undefined === q) return undefined
    tail = [q[0] * 256 + q[1], q[2] * 256 + q[3]]
    rest = rest.slice(0, rest.length - dotted[2].length)
    if (rest.endsWith(':') && !rest.endsWith('::')) rest = rest.slice(0, -1)
  }
  const sides = rest.split('::')
  if (2 < sides.length) return undefined
  const read = (side: string): number[] | undefined => {
    if ('' === side) return []
    const out = side.split(':').map((h) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : -1))
    return out.every((n) => 0 <= n) ? out : undefined
  }
  const head = read(sides[0])
  const mid = 2 === sides.length ? read(sides[1]) : []
  if (undefined === head || undefined === mid) return undefined
  const want = 8 - tail.length
  if (2 === sides.length) {
    if (want <= head.length + mid.length) return undefined
    return [...head, ...new Array(want - head.length - mid.length).fill(0), ...mid, ...tail]
  }
  return want === head.length ? [...head, ...tail] : undefined
}

// Whether an address is one of the public internet's. Anything this
// cannot read as an address is not.
function isPublicAddress(address: string): boolean {
  const v4 = quad(address)
  if (undefined !== v4) return publicV4(v4)
  const h = hextets(address)
  if (undefined === h) return false
  const embedded = [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255]
  const zeros = (n: number) => h.slice(0, n).every((x) => 0 === x)
  // Unspecified, loopback, and the old IPv4-compatible form.
  if (zeros(6)) return false
  // IPv4-mapped, and the NAT64 prefix: as the IPv4 address inside.
  if (zeros(5) && 0xffff === h[5]) return publicV4(embedded)
  if (0x64 === h[0] && 0xff9b === h[1] && h.slice(2, 6).every((x) => 0 === x)) return publicV4(embedded)
  // 6to4 carries an IPv4 address in its next two.
  if (0x2002 === h[0]) return publicV4([h[1] >> 8, h[1] & 255, h[2] >> 8, h[2] & 255])
  if (0xfc00 === (h[0] & 0xfe00)) return false
  if (0xfe80 === (h[0] & 0xffc0)) return false
  if (0xff00 === (h[0] & 0xff00)) return false
  if (0x2001 === h[0] && 0x0db8 === h[1]) return false
  return true
}

type Answer = { status: number; location?: string; body?: Uint8Array }

// A loader of documents over HTTP, from the hosts the caller lists. It
// reads a document named by an `http:` or `https:` URI, and has none for
// any other URI or for one the server answers 404 or 410 for.
function httpLoader(options: HttpLoaderOptions): Loader {
  if (null == options || !Array.isArray(options.hosts) || options.hosts.some((h) => 'string' !== typeof h || '' === h)) {
    throw new TypeError('httpLoader: hosts must be a list of host names, not ' + quoted(JSON.stringify(options?.hosts)))
  }
  const hosts = new Set(options.hosts.map((h) => h.toLowerCase()))
  const schemes = new Set<string>((options.schemes ?? ['https']).map((s) => s + ':'))
  for (const s of schemes) {
    if ('http:' !== s && 'https:' !== s) throw new TypeError('httpLoader: schemes are http and https, not ' + quoted(s.slice(0, -1)))
  }
  const count = (name: string, value: number | undefined, unless: number): number => {
    const n = value ?? unless
    if (!(('number' === typeof n && 0 <= n) || Infinity === n)) {
      throw new TypeError(`httpLoader: ${name} must be a number of 0 or more, not ` + quoted(n))
    }
    return n
  }
  const maxBytes = count('maxBytes', options.maxBytes, 16 * 1024 * 1024)
  const timeoutMs = count('timeoutMs', options.timeoutMs, 10_000)
  const maxRedirects = count('maxRedirects', options.maxRedirects, 5)
  const anywhere = true === options.privateAddresses
  const headersBy = options.headers ?? {}
  const resolveHost =
    options.lookup ?? (async (host: string): Promise<Address[]> => dns.lookup(host, { all: true }) as Promise<Address[]>)
  const kept = false === options.cache ? undefined : new Map<string, Promise<Uint8Array | undefined>>()

  // The loader's own connections. The agent a process shares finds a
  // connection it has kept by the name of its host, whatever address it
  // was opened to, so a request through it could go out on a connection
  // that other code of the process opened, to an address this loader
  // never judged. A kept connection lies unused without holding the
  // process open.
  let plain: http.Agent | undefined
  let secure: https.Agent | undefined
  const agentFor = (protocol: string): http.Agent =>
    'https:' === protocol
      ? (secure ??= new https.Agent({ keepAlive: true }))
      : (plain ??= new http.Agent({ keepAlive: true }))

  // One request, to the addresses already judged, so that the name is not
  // resolved again between the judging and the asking. Node is handed
  // every one of them, and tries the next where it cannot reach the
  // first: a host with an IPv6 address is otherwise out of reach from a
  // machine that has no route for one.
  const ask = (url: URL, to: Address[], signal: AbortSignal, again = true): Promise<Answer> =>
    new Promise((done, fail) => {
      const lib = 'https:' === url.protocol ? https : http
      const pinned = (_host: string, opts: any, cb: any) => {
        if (opts?.all) cb(null, to)
        else cb(null, to[0].address, to[0].family)
      }
      let answered = false
      const req = lib.request(
        url,
        {
          method: 'GET',
          signal,
          // A second asking opens a connection, and keeps none.
          agent: again ? agentFor(url.protocol) : false,
          lookup: pinned as any,
          headers: {
            accept: 'application/yaml, application/json, */*;q=0.5',
            'accept-encoding': 'identity',
            ...(headersBy[url.origin] ?? {}),
          },
        },
        (res) => {
          answered = true
          const status = res.statusCode ?? 0
          if (300 <= status && status < 400 && 'string' === typeof res.headers.location) {
            res.resume()
            return done({ status, location: res.headers.location })
          }
          if (status < 200 || 300 <= status) {
            res.resume()
            return done({ status })
          }
          const said = Number(res.headers['content-length'])
          if (maxBytes < said) {
            req.destroy()
            return fail(new ResolveError('openapi_load', `load: ${quoted(url.href)} is ${said} bytes, and this loader reads ${maxBytes} at most`, url.href))
          }
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (maxBytes < size) {
              req.destroy()
              fail(new ResolveError('openapi_load', `load: ${quoted(url.href)} is more than the ${maxBytes} bytes this loader reads`, url.href))
            } else chunks.push(chunk)
          })
          res.on('end', () => done({ status, body: new Uint8Array(Buffer.concat(chunks)) }))
          res.on('error', fail)
        },
      )
      req.on('error', (err: any) => {
        // A kept connection that its server closed while it lay unused
        // fails the request that takes it up, before any of it is
        // answered: as a reset here, and under other names on other
        // systems. That request is asked once more, on a connection of
        // its own. One that fails on a new connection is not.
        const stale = req.reusedSocket && !answered && !signal.aborted
        if (again && stale) ask(url, to, signal, false).then(done, fail)
        else fail(err)
      })
      req.end()
    })

  const read = async (uri: string): Promise<Uint8Array | undefined> => {
    const limit = Infinity === timeoutMs ? undefined : AbortSignal.timeout(timeoutMs)
    const both = [options.signal, limit].filter((s): s is AbortSignal => undefined !== s)
    const signal = 1 === both.length ? both[0] : 0 === both.length ? new AbortController().signal : AbortSignal.any(both)
    let current = uri
    for (let hops = 0; ; hops++) {
      let url: URL
      try {
        url = new URL(current)
      } catch {
        return refuse(`${quoted(current)} is no URL`, uri)
      }
      if (!schemes.has(url.protocol)) return refuse(`${quoted(current)} is of a scheme this loader does not read`, uri)
      if (!hosts.has(url.host.toLowerCase())) return refuse(`${quoted(current)} is on a host this loader does not read`, uri)
      if ('' !== url.username || '' !== url.password) return refuse(`${quoted(url.origin)} is named with credentials in the URI`, uri)
      url.hash = ''
      const name = url.hostname.replace(/^\[|\]$/g, '')
      let found: Address[]
      try {
        found = 0 !== isIP(name) ? [{ address: name, family: isIP(name) }] : await resolveHost(name)
      } catch (err: any) {
        return refuse(`${quoted(name)} has no address: ${String(err?.code ?? err?.message ?? err)}`, uri)
      }
      if (0 === found.length) return refuse(`${quoted(name)} has no address`, uri)
      if (!anywhere) {
        const inside = found.find((a) => !isPublicAddress(a.address))
        if (undefined !== inside) {
          return refuse(`${quoted(name)} is at ${inside.address}, which is no public address`, uri)
        }
      }
      let answer: Answer
      try {
        answer = await ask(url, found, signal)
      } catch (err: any) {
        if (err instanceof ResolveError) throw err
        const why = signal.aborted ? (limit?.aborted ? `took more than ${timeoutMs} ms` : 'was stopped') : String(err?.code ?? err?.message ?? err)
        return refuse(`${quoted(url.href)} could not be read: ${why}`, uri)
      }
      if (undefined !== answer.location) {
        if (maxRedirects <= hops) return refuse(`${quoted(uri)} redirects more than ${maxRedirects} times`, uri)
        current = new URL(answer.location, url).href
        continue
      }
      if (404 === answer.status || 410 === answer.status) return undefined
      if (undefined === answer.body) return refuse(`${quoted(url.href)} answered ${answer.status}`, uri)
      return answer.body
    }
  }

  return (uri: string) => {
    if (!/^https?:/i.test(uri)) return undefined
    if (undefined === kept) return read(uri)
    let got = kept.get(uri)
    if (undefined === got) {
      got = read(uri)
      kept.set(uri, got)
      // What failed is asked for again next time.
      got.catch(() => kept.delete(uri))
    }
    return got
  }
}

export { fileLoader, httpLoader, isPublicAddress }

export type { Address, FileLoaderOptions, HttpLoaderOptions }
