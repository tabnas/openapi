/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The loaders `resolveAll` can be given. `resolveAll` reads nothing by
// itself: its `load` is the caller's, and a description names whatever
// documents its author chose. Each loader here is made by the caller,
// with the bound on what it may reach stated when it is made, and none
// is on by default. The main module does not load this one, so a caller
// who makes no loader has no file or network code in reach.
//
//   fileLoader   files under one directory, and nothing outside it
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

import { promises as fs } from 'node:fs'
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

export { fileLoader }

export type { FileLoaderOptions }
