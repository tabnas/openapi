/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */
'use strict'

// tools/apidef-gate/reporter.cjs: a reporter for `node --test` that writes
// one JSON object per line, for tools/apidef-gate.cjs to count and name
// tests by. It writes only the events the gate reads: each test's start,
// pass and failure, and the run's summary.

const first = (text, lines) =>
  String(text ?? '').split('\n').slice(0, lines).join('\n')

function errorText(err) {
  if (null == err) return undefined
  const cause = err.cause ?? err
  return first(cause?.message ?? String(cause), 16)
}

module.exports = async function* reporter(source) {
  for await (const event of source) {
    const data = event.data ?? {}
    const base = { file: data.file, line: data.line, nesting: data.nesting, name: data.name }
    if ('test:start' === event.type) {
      yield JSON.stringify({ event: 'start', ...base }) + '\n'
    } else if ('test:pass' === event.type || 'test:fail' === event.type) {
      const details = data.details ?? {}
      yield JSON.stringify({
        event: 'test:pass' === event.type ? 'pass' : 'fail',
        ...base,
        type: details.type,
        skip: undefined !== data.skip && false !== data.skip,
        todo: undefined !== data.todo && false !== data.todo,
        error: 'test:fail' === event.type ? errorText(details.error) : undefined,
      }) + '\n'
    } else if ('test:summary' === event.type && null == data.file) {
      yield JSON.stringify({ event: 'summary', counts: data.counts, success: data.success }) + '\n'
    }
  }
}
