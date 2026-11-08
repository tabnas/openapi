// E1: expr as a SUB-PARSER for the strings OpenAPI puts references in:
//   (a) runtime expressions   $request.body#/user/uuid, {$request.query.q}
//   (b) $ref URIs             #/components/schemas/Pet, ./x.yaml#/a, https://...
//   (c) path templates        /pets/{petId}/photos/{photoId}
// Each gets its own operator table on a jsonic+Expr instance with comments,
// pairs and containers switched off so the string is read as ONE expression.
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Expr, simplify } = require('@tabnas/expr')

const NO_DEFAULTS = { positive: null, negative: null, addition: null,
  subtraction: null, multiplication: null, division: null, remainder: null, plain: null }

function instance(ops, extra = {}) {
  const tn = new Tabnas().use(jsonic)
  tn.options({
    comment: { lex: false },               // `#` must not start a comment
    fixed: { token: { '#CL': null, '#OB': null, '#CB': null, '#OS': null, '#CS': null, '#CA': null } },
    rule: { exclude: 'imp' },              // no jsonic implicit maps/lists; expr's own implicit list, added when it is use()d, survives this
    number: { lex: false },                // a pointer segment "1" is text, not 1
    value: { lex: false },                 // ... and "true" is text, not true
    ...extra,
  })
  return tn.use(Expr, { op: { ...NO_DEFAULTS, ...ops } })
}

function run(title, tn, cases) {
  console.log('\n## ' + title)
  let ok = 0
  for (const [src, want] of cases) {
    let got, err
    try { got = JSON.stringify(simplify(tn.parse(src))) } catch (e) { err = e.code || e.message.split('\n')[0] }
    const pass = 'ERROR' === want ? !!err : got === JSON.stringify(want)
    ok += pass ? 1 : 0
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${JSON.stringify(src)}\n      -> ${err ? 'ERROR ' + err : got}${!pass && want ? '\n      want ' + JSON.stringify(want) : ''}`)
  }
  console.log(`${ok}/${cases.length} as expected`)
}

// (a) Runtime expressions. Tiers: `.` member 7e6 (tightest), `/` pointer
// segment 6e6 (prefix + infix), `#` fragment 5e6, `{ }` template paren.
const rt = instance({
  member:   { infix: true, src: '.', left: 7000000, right: 7100000 },
  segment:  { infix: true, src: '/', left: 6000000, right: 6100000 },
  segment0: { prefix: true, src: '/', right: 6000000 },
  fragment: { infix: true, src: '#', left: 5000000, right: 5100000 },
  template: { paren: true, osrc: '{', csrc: '}' },
})
run('(a) runtime expressions (OAS 4.20.3 ABNF)', rt, [
  ['$method', '$method'],
  ['$url', '$url'],
  ['$statusCode', '$statusCode'],
  ['$request.path.id', ['.', ['.', '$request', 'path'], 'id']],
  ['$request.header.accept', ['.', ['.', '$request', 'header'], 'accept']],
  ['$response.header.X-Rate-Limit', ['.', ['.', '$response', 'header'], 'X-Rate-Limit']],
  ['$request.body#/user/uuid', ['#', ['.', '$request', 'body'], ['/', ['/', 'user'], 'uuid']]],
  ['$request.body#/successUrls/1', ['#', ['.', '$request', 'body'], ['/', ['/', 'successUrls'], '1']]],
  ['$request.body', ['.', '$request', 'body']],
  ['$request.body#', ['#', ['.', '$request', 'body']]],   // empty pointer = whole body: a 1-term `#`
  ['{$request.body#/callbackUrl}/data', ['/', ['{', ['#', ['.', '$request', 'body'], ['/', 'callbackUrl']]], 'data']],
  ['{$request.query.queryUrl}', ['{', ['.', ['.', '$request', 'query'], 'queryUrl']]],
  ['http://notificationServer.com?transactionId={$request.body#/id}&email={$request.body#/email}', 'ERROR'],
  ['$request.body#/a~1b', ['#', ['.', '$request', 'body'], ['/', 'a~1b']]],  // ~1 must still be decoded by the evaluator
  // ABNF-legal names the operator table MUST misread: after `header.`,
  // `query.` and `path.` the rest of the string is ONE name (name = *char,
  // token = 1*tchar with "." "#" "~" among tchar), and a JSON Pointer
  // reference-token may hold "." or ",". A binding power is global, so `.`
  // cannot be an operator left of `#` and inert right of it.
  ['$request.query.a.b', ['.', ['.', '$request', 'query'], 'a.b']],
  ['$request.header.X.Y', ['.', ['.', '$request', 'header'], 'X.Y']],
  ['$request.header.X#Y', ['.', ['.', '$request', 'header'], 'X#Y']],
  ['$request.body#/user.name', ['#', ['.', '$request', 'body'], ['/', 'user.name']]],
  ['$request.body#/a,b', ['#', ['.', '$request', 'body'], ['/', 'a,b']]],
  ['$request.body#/a//b', ['#', ['.', '$request', 'body'], ['/', ['/', ['/', 'a'], ''], 'b']]],
  ['$request.query.', ['.', ['.', '$request', 'query']]],       // name = *char admits an empty name: legal, a one-term `.`
  // the specification's remaining table rows, so every example is run
  ['$response.body#/status', ['#', ['.', '$response', 'body'], ['/', 'status']]],
  ['$response.header.Server', ['.', ['.', '$response', 'header'], 'Server']],
  ['$request.path.eventType', ['.', ['.', '$request', 'path'], 'eventType']],
  ['$request.header.content-type', ['.', ['.', '$request', 'header'], 'content-type']],
  ['$request.body#/failedUrl', ['#', ['.', '$request', 'body'], ['/', 'failedUrl']]],
  ['$response.header.Location', ['.', ['.', '$response', 'header'], 'Location']],
  ['$response.body#/uuid', ['#', ['.', '$response', 'body'], ['/', 'uuid']]],
  ['$response.body#/username', ['#', ['.', '$response', 'body'], ['/', 'username']]],
  ['$request.body#/url', ['#', ['.', '$request', 'body'], ['/', 'url']]],
])

// (b) $ref URIs. No `.` op (file names carry dots); `/`, `#` as above.
const ref = instance({
  segment:  { infix: true, src: '/', left: 6000000, right: 6100000 },
  segment0: { prefix: true, src: '/', right: 6000000 },
  fragment: { infix: true, src: '#', left: 5000000, right: 5100000 },
  fragment0:{ prefix: true, src: '#', right: 5000000 },
})
run('(b) $ref URIs (RFC 3986 + RFC 6901 fragment)', ref, [
  ['#/components/schemas/Pet', ['#', ['/', ['/', ['/', 'components'], 'schemas'], 'Pet']]],
  ['Pet.yaml', 'Pet.yaml'],
  ['definitions.yaml#/Pet', ['#', 'definitions.yaml', ['/', 'Pet']]],
  ['./common.yaml#/components/schemas/Error', ['#', ['/', '.', 'common.yaml'], ['/', ['/', ['/', 'components'], 'schemas'], 'Error']]],
  ['../schemas/pet.json', ['/', ['/', '..', 'schemas'], 'pet.json']],
  ['#/paths/~12.0~1repositories~1%7Busername%7D/get', ['#', ['/', ['/', ['/', 'paths'], '~12.0~1repositories~1%7Busername%7D'], 'get']]],
  ['#/components/schemas/Foo%20Bar', ['#', ['/', ['/', ['/', 'components'], 'schemas'], 'Foo%20Bar']]],
  ['#/components/schemas/1', ['#', ['/', ['/', ['/', 'components'], 'schemas'], '1']]],
  ['#/components/schemas/true', ['#', ['/', ['/', ['/', 'components'], 'schemas'], 'true']]],
  ['#/components/schemas/a b', 'ERROR'],   // a raw space is illegal in a URI; expr reads an implicit list instead
  ['#/components/schemas/a,b', ['#', ['/', ['/', ['/', 'components'], 'schemas'], 'a,b']]],  // `,` is legal in a token
  ['#', ['#']],                            // the empty fragment names the whole document: legal, one-term `#`
  ['https://example.com/schemas/pet.json', 'ERROR'],  // scheme and authority are not path segments
  ['#/paths/~1pets~1{id}/get', 'ERROR'],  // `{` inside a segment: must be %7B
])

// (c) path templates and server URL templates.
const path = instance({
  segment:  { infix: true, src: '/', left: 6000000, right: 6100000 },
  segment0: { prefix: true, src: '/', right: 6000000 },
  template: { paren: true, osrc: '{', csrc: '}' },
})
run('(c) path templates (OAS 4.8.2 ABNF)', path, [
  ['/pets', ['/', 'pets']],
  ['/pets/{petId}', ['/', ['/', 'pets'], ['{', 'petId']]],
  ['/pets/{petId}/photos/{photoId}', ['/', ['/', ['/', ['/', 'pets'], ['{', 'petId']], 'photos'], ['{', 'photoId']]],
  ['/users/{id}.json', ['/', ['/', 'users'], [['{', 'id'], '.json']]],   // literal glued to a template
  ['/files/{path}:download', ['/', ['/', 'files'], [['{', 'path'], ':download']]],
  ['/', ['/']],
  ['https://{username}.gigantic-server.com:{port}/{basePath}', 'ERROR'],
])
