/* Copyright (c) 2026 Richard Rodger and other contributors, MIT License */

// The two small languages a description writes inside its strings.
//
// A runtime expression names a value of one HTTP request and its
// response: `$request.path.id`, `$response.body#/data/0`. A Link's
// parameters and request body hold them, and a Callback's key is one,
// alone or between braces in a URL.
//
// A template is text with names between braces: a path
// (`/pets/{petId}`), a server's URL (`https://{region}.example.com`),
// and a callback's key, where what is between the braces is a runtime
// expression.
//
// Both are read as the ABNF in the specification has them, which is
// lexical. What follows `query.` is the name, to the end, whatever
// characters it has: a query parameter named `a.b` is
// `$request.query.a.b`, and the pointer of `$request.body#/a%2Fb` has the
// token `a%2Fb`, since it is no URI fragment and is not percent-decoded.
// An operator grammar splits both, which is why none is used here.
//
// Nothing is given a value when a description is read: an expression
// needs a request to have one. `evaluateExpression` takes the request
// and the response from the caller.

import { NOTHING, isMap, own, stepInto } from './uri'

type ExpressionSource = 'url' | 'method' | 'statusCode' | 'request' | 'response'

type ExpressionKind = 'header' | 'query' | 'path' | 'body'

type Expression = {
  // The expression as written.
  expression: string
  source: ExpressionSource
  // What of the request or the response it names.
  kind?: ExpressionKind
  // The header, the query parameter or the path parameter it names, as
  // written. A header's name is compared without regard to case, the
  // other two exactly.
  name?: string
  // For a body, the JSON Pointer after `#` as written, and its tokens
  // with `~1` and `~0` read. Both are absent for the whole body.
  pointer?: string
  tokens?: string[]
}

type TemplateKind = 'path' | 'server' | 'runtime'

// One part of a template: text to keep, or what is between two braces.
// Under `runtime` that is a runtime expression, read.
type TemplatePart = { literal: string } | { name: string; expression?: Expression }

type Template = {
  // The template as written.
  template: string
  kind: TemplateKind
  parts: TemplatePart[]
}

// One side of an exchange, as `evaluateExpression` reads it. `headers` is
// a map from name to value, or anything that gives name and value pairs:
// a Map, a list of pairs, the Headers of the Fetch API. `body` is the
// body already parsed.
type HttpMessage = {
  headers?: Record<string, unknown> | Iterable<readonly [string, unknown]>
  query?: Record<string, unknown>
  path?: Record<string, unknown>
  body?: unknown
}

type Exchange = {
  request?: HttpMessage & { url?: string; method?: string }
  response?: HttpMessage & { statusCode?: number | string }
}

class ExpressionError extends Error {
  code: string
  // The text that was read, and the offset in it where reading stopped.
  text: string
  offset: number
  constructor(message: string, text: string, offset: number) {
    super(message)
    this.name = 'ExpressionError'
    this.code = 'openapi_expression'
    this.text = text
    this.offset = offset
  }
}

// Document content in a message: JSON-quoted and cut short.
function quoted(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return 60 < text.length ? text.slice(0, 57) + '...' : text
}

function fail(what: string, text: string, offset: number): never {
  throw new ExpressionError(`${what}, at offset ${offset} of ${quoted(text)}`, text, offset)
}

// RFC 9110's token, which a header's name is.
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// A literal of an ABNF grammar matches without regard to case (RFC 5234,
// section 2.3), so `$URL` is `$url`. Without the `u` flag a pattern's `i`
// folds ASCII letters alone, which is what an ABNF literal means.
const WHOLE: [RegExp, ExpressionSource][] = [
  [/^\$url$/i, 'url'],
  [/^\$method$/i, 'method'],
  [/^\$statusCode$/i, 'statusCode'],
]
const SIDE = /^\$(request|response)\./i
const HEADER = /^header\./i
const QUERY = /^query\./i
const PATH = /^path\./i
const BODY = /^body/i

// The tokens of a JSON Pointer that is no URI fragment (RFC 6901,
// section 3).
function pointerTokens(pointer: string, text: string, offset: number): string[] {
  if ('' === pointer) return []
  if ('/' !== pointer[0]) fail('a JSON Pointer is empty or starts with /', text, offset)
  const bad = /~(?![01])/.exec(pointer)
  if (null != bad) fail('in a JSON Pointer a ~ is followed by 0 or 1', text, offset + bad.index)
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
}

// Read a runtime expression. The whole text is the expression: one
// between braces is a template's, and `readTemplate` reads that.
function readExpression(text: string): Expression {
  if ('string' !== typeof text) throw new TypeError('readExpression: an expression is a string, not ' + quoted(text))
  for (const [pattern, source] of WHOLE) if (pattern.test(text)) return { expression: text, source }
  const side = SIDE.exec(text)
  if (null == side) fail('an expression is $url, $method, $statusCode, or starts with $request. or $response.', text, 0)
  const source = side![1].toLowerCase() as 'request' | 'response'
  const at = side![0].length
  const rest = text.slice(at)
  if (HEADER.test(rest)) {
    const name = rest.slice(7)
    if (!TOKEN.test(name)) {
      let i = 0
      while (i < name.length && TCHAR.test(name[i])) i++
      fail(
        '' === name ? 'a header reference names a header' : 'a header name is a token of RFC 9110',
        text,
        at + 7 + i,
      )
    }
    return { expression: text, source, kind: 'header', name }
  }
  if (QUERY.test(rest)) return { expression: text, source, kind: 'query', name: rest.slice(6) }
  if (PATH.test(rest)) return { expression: text, source, kind: 'path', name: rest.slice(5) }
  if (BODY.test(rest)) {
    const after = rest.slice(4)
    if ('' === after) return { expression: text, source, kind: 'body' }
    if ('#' === after[0]) {
      const pointer = after.slice(1)
      return { expression: text, source, kind: 'body', pointer, tokens: pointerTokens(pointer, text, at + 5) }
    }
    fail('after body comes nothing, or # and a JSON Pointer', text, at + 4)
  }
  return fail('after $request. or $response. comes header., query., path. or body', text, at)
}

const KINDS: TemplateKind[] = ['path', 'server', 'runtime']

// Read a template: a path, a server's URL, or, under `runtime`, a
// callback's key or a Link's value. The specification's grammars for the
// first two allow any character but a brace between braces, and several
// expressions in one segment, which is wider than RFC 6570. A runtime
// template that is one bare expression, as `$request.body#/url` is, has
// that as its one part.
//
// Only the braces are held to the grammar: a brace that is not closed,
// one inside another, a closing one with none open, and braces with
// nothing between them are refused. The characters of the literal parts
// are not judged.
function readTemplate(text: string, kind: TemplateKind = 'path'): Template {
  if ('string' !== typeof text) throw new TypeError('readTemplate: a template is a string, not ' + quoted(text))
  if (!KINDS.includes(kind)) {
    throw new TypeError(`readTemplate: kind must be one of ${KINDS.join(', ')}, not ${quoted(kind)}`)
  }
  if ('runtime' === kind && '$' === text[0]) {
    let bare: Expression | undefined
    try {
      bare = readExpression(text)
    } catch (err) {
      if (!(err instanceof ExpressionError)) throw err
    }
    if (undefined !== bare) return { template: text, kind, parts: [{ name: text, expression: bare }] }
  }
  const parts: TemplatePart[] = []
  let literal = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if ('}' === c) fail('a } with no { before it', text, i)
    if ('{' !== c) {
      literal += c
      i++
      continue
    }
    const close = text.indexOf('}', i + 1)
    const open = text.indexOf('{', i + 1)
    if (-1 === close) fail('a { that is not closed', text, i)
    if (-1 !== open && open < close) fail('a { inside braces', text, open)
    const name = text.slice(i + 1, close)
    if ('' === name) fail('braces with nothing between them', text, i)
    if ('' !== literal) {
      parts.push({ literal })
      literal = ''
    }
    if ('runtime' === kind) {
      let expression: Expression
      try {
        expression = readExpression(name)
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err
        // The place is the template's, not the expression's alone.
        return fail(
          err.message.replace(/, at offset \d+ of .*$/s, ''),
          text,
          i + 1 + err.offset,
        )
      }
      parts.push({ name, expression })
    } else parts.push({ name })
    i = close + 1
  }
  if ('' !== literal) parts.push({ literal })
  return { template: text, kind, parts }
}

// The names between a template's braces, in order.
function namesOf(template: Template): string[] {
  const names: string[] = []
  for (const part of template.parts) if ('name' in part) names.push(part.name)
  return names
}

// A header's value, its name compared without regard to case, as HTTP
// has it.
function headerOf(headers: HttpMessage['headers'], name: string): unknown {
  if (null == headers || 'object' !== typeof headers) return undefined
  const want = name.toLowerCase()
  if (isMap(headers)) {
    const named = headers as Record<string, unknown>
    for (const key of Object.keys(named)) if (key.toLowerCase() === want) return named[key]
    return undefined
  }
  if ('function' !== typeof (headers as any)[Symbol.iterator]) return undefined
  for (const pair of headers as Iterable<readonly [string, unknown]>) {
    if (Array.isArray(pair) && 'string' === typeof pair[0] && pair[0].toLowerCase() === want) return pair[1]
  }
  return undefined
}

function valueOf(e: Expression, exchange: Exchange): unknown {
  if ('url' === e.source) return exchange.request?.url
  if ('method' === e.source) return exchange.request?.method
  if ('statusCode' === e.source) return exchange.response?.statusCode
  const message: HttpMessage | undefined = 'request' === e.source ? exchange.request : exchange.response
  if (null == message || 'object' !== typeof message) return undefined
  if ('header' === e.kind) return headerOf(message.headers, e.name!)
  if ('query' === e.kind || 'path' === e.kind) {
    const named = message[e.kind]
    return isMap(named) && own(named, e.name!) ? named[e.name!] : undefined
  }
  let node: any = message.body
  for (const token of e.tokens ?? []) {
    node = stepInto(node, token)
    if (NOTHING === node) return undefined
  }
  return node
}

function isTemplate(value: unknown): value is Template {
  return null != value && 'object' === typeof value && Array.isArray((value as Template).parts)
}

// The value an expression names in one exchange, with its type as it is
// there, or undefined where the exchange has none. A runtime template
// gives its text with each expression's value in its place, and
// undefined where one of them has none. An expression given as text is
// read first, and one that is not an expression is refused as
// `readExpression` refuses it.
function evaluateExpression(expr: string | Expression | Template, exchange: Exchange): unknown {
  if (null == exchange || 'object' !== typeof exchange) {
    throw new TypeError('evaluateExpression: an exchange is an object with a request and a response')
  }
  if (isTemplate(expr)) {
    if ('runtime' !== expr.kind) {
      throw new TypeError(`evaluateExpression: a ${expr.kind} template holds names, and no runtime expressions`)
    }
    // One bare expression keeps its value's type.
    if (1 === expr.parts.length && 'name' in expr.parts[0] && expr.parts[0].name === expr.template) {
      return valueOf(expr.parts[0].expression!, exchange)
    }
    let out = ''
    for (const part of expr.parts) {
      if ('literal' in part) {
        out += part.literal
        continue
      }
      const value = valueOf(part.expression!, exchange)
      if (undefined === value) return undefined
      out += 'string' === typeof value ? value : null !== value && 'object' === typeof value ? JSON.stringify(value) : String(value)
    }
    return out
  }
  const e = 'string' === typeof expr ? readExpression(expr) : expr
  if (null == e || 'object' !== typeof e || 'string' !== typeof e.source) {
    throw new TypeError('evaluateExpression: an expression is text, or what readExpression gives, not ' + quoted(expr))
  }
  return valueOf(e, exchange)
}

export { ExpressionError, evaluateExpression, namesOf, readExpression, readTemplate }

export type { Exchange, Expression, ExpressionKind, ExpressionSource, HttpMessage, Template, TemplateKind, TemplatePart }
