/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-preset/apidef.cjs: apidef's own resolver, loaded from a
// checkout's build.
//
// apidef's resolver is private to its parse module (ts/dist/parse.js):
// `addXRefsAndResolve` and `resolvePointer` are not exported. This reads
// that module's source as it is built, adds one line at its end that
// hands those two functions out, and evaluates it as a CommonJS module
// with a `require` rooted in the file itself, so that its own imports
// resolve beside it. Nothing of apidef's is copied into this harness, so
// a change to apidef's resolver is a change to what the harness tests.
//
// The build is the checkout's working tree, or, with `ref`, the build
// committed at that commit (apidef commits ts/dist), taken with `git
// archive` into a temporary folder whose ts/node_modules is a link to the
// checkout's own. The checkout is only read: no worktree, no checkout, no
// file written in it.
//
// A module for apidef-preset.cjs and its worker; it runs nothing by itself.

const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')
const Crypto = require('node:crypto')
const Child = require('node:child_process')
const { createRequire } = require('node:module')

const WANTED = ['addXRefsAndResolve', 'resolvePointer']

class LoadError extends Error {}

const git = (dir, args, opts = {}) =>
  Child.execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts })

// The build to load: { file, commit, dirty, tmp }. With `ref`, a copy of
// that commit's ts/dist in a new folder under `workDir`.
function locate(checkout, ref, workDir) {
  const dir = Path.resolve(checkout)
  if (!Fs.existsSync(Path.join(dir, 'ts', 'package.json'))) throw new LoadError(`${dir} has no ts/package.json; is it an apidef checkout?`)
  const modules = Path.join(dir, 'ts', 'node_modules')
  if (!Fs.existsSync(modules)) throw new LoadError(`${modules} is missing: apidef's dependencies are not installed (npm ci in its ts/)`)
  if (null == ref) {
    let commit = null
    let dirty = null
    try {
      commit = git(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      dirty = '' !== git(dir, ['status', '--short', '--', 'ts/dist/parse.js'], { encoding: 'utf8' }).trim()
    } catch {
      // Not a git checkout: the file is read as it is.
    }
    return { file: Path.join(dir, 'ts', 'dist', 'parse.js'), commit, dirty, tmp: null }
  }
  let commit
  try {
    commit = git(dir, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { encoding: 'utf8' }).trim()
  } catch {
    throw new LoadError(`${dir} has no commit ${ref}`)
  }
  let tar
  try {
    tar = git(dir, ['archive', '--format=tar', commit, 'ts/dist'])
  } catch (err) {
    throw new LoadError(`apidef ${commit.slice(0, 7)} has no committed ts/dist: ${String(err.stderr ?? err.message).trim()}`)
  }
  const tmp = Fs.mkdtempSync(Path.join(workDir ?? Fs.realpathSync(Os.tmpdir()), 'apidef-preset-'))
  Child.execFileSync('tar', ['-x', '-C', tmp], { input: tar, stdio: ['pipe', 'ignore', 'pipe'] })
  Fs.symlinkSync(modules, Path.join(tmp, 'ts', 'node_modules'), 'dir')
  return { file: Path.join(tmp, 'ts', 'dist', 'parse.js'), commit, dirty: false, tmp }
}

function evaluate(file) {
  if (!Fs.existsSync(file)) throw new LoadError(`no ${file}: apidef's ts/ is not built`)
  const src = Fs.readFileSync(file, 'utf8')
  for (const name of WANTED) {
    if (!new RegExp('\\bfunction\\s+' + name + '\\s*\\(').test(src)) {
      throw new LoadError(
        `${file} defines no function ${name}: this build of apidef has no resolver of its own ` +
        '(give --ref with a commit that has one), or the resolver has changed shape and this harness must follow it')
    }
  }
  const hand = '\n;module.exports.__apidefPreset = { ' + WANTED.map((n) => `${n}: ${n}`).join(', ') + ' }\n'
  const mod = { exports: {} }
  let fn
  try {
    fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src + hand)
  } catch (err) {
    throw new LoadError(`${file} does not compile with the added export line: ${err.message}`)
  }
  try {
    fn.call(mod.exports, mod.exports, createRequire(file), mod, file, Path.dirname(file))
  } catch (err) {
    throw new LoadError(`${file} failed to load (are apidef's dependencies installed in its ts/node_modules?): ${err.message}`)
  }
  const got = mod.exports.__apidefPreset
  for (const name of WANTED) {
    if ('function' !== typeof got?.[name]) throw new LoadError(`${file}: ${name} is not a function after loading`)
  }
  return { got, sha1: Crypto.createHash('sha1').update(src).digest('hex') }
}

// { addXRefsAndResolve, resolvePointer, file, commit, dirty, sha1, cleanup }.
// `file` names the build that was loaded; `cleanup` removes the copy made for `ref`.
function loadApidef(checkout, { ref = null, workDir = null } = {}) {
  const where = locate(checkout, ref, workDir)
  const cleanup = () => {
    if (where.tmp) Fs.rmSync(where.tmp, { recursive: true, force: true })
  }
  try {
    const { got, sha1 } = evaluate(where.file)
    return { ...got, file: where.file, commit: where.commit, dirty: where.dirty, ref, sha1, tmp: where.tmp, cleanup }
  } catch (err) {
    cleanup()
    throw err
  }
}

// The build as a worker loads it again: the file the parent found.
function loadFile(file) {
  const { got, sha1 } = evaluate(file)
  return { ...got, file, sha1 }
}

module.exports = { loadApidef, loadFile, LoadError }
