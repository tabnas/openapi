/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The parser `make()` builds declares `lex.window` false, its own setting,
// in either mode, so that `parseReader` reads a reader whole (admin
// ADR-30): the plugin is not yet verified at the window's edge. `make()`
// builds its base inline, so the proof that the setting wins over a base
// that declares the window is the Go and Rust ports' (`makeOn`, `make_on`),
// whose constructors take their base as a step.

import { describe, test } from 'node:test'
import assert from 'node:assert'

import { make } from '../dist/openapi'

describe('window', () => {
  test('make-declares-no-window', () => {
    const loose = make() as any
    assert.equal(loose.internal().config.lex.window, false)
    const strict = make({ strict: true }) as any
    assert.equal(strict.internal().config.lex.window, false)
  })
})
