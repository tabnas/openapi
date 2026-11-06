// E2: expr's `evaluate` option is EAGER — it runs when each expression
// closes. A document-level meta operation ($ref) resolves against the WHOLE
// document, usually a part parsed later (components after paths). Show the
// difference between evaluating at close and evaluating after the parse.
const { Tabnas } = require('@tabnas/parser')
const { jsonic } = require('@tabnas/jsonic')
const { Expr, evaluation, simplify } = require('@tabnas/expr')

// A prefix operator `@name` meaning "the value of components.schemas.<name>".
const op = { lookup: { prefix: true, src: '@', right: 5000000 } }
const resolve = (root) => (rule, ctx, o, terms) => {
  const hit = root?.components?.schemas?.[terms[0]]
  return undefined === hit ? `<unresolved ${terms[0]}>` : hit
}

const src = `{
  paths: { "/pets": { get: { schema: @Pet } } },
  components: { schemas: { Pet: { type: object } } },
}`

// 1. eager: evaluate at expression close, looking at the tree built SO FAR.
//    `ctx.root()` is the start RULE; its node is set only when that rule
//    coalesces its child at its own close, so it is undefined here. The
//    partial document is the outermost container on the rule stack: the
//    root map is allocated at map open and filled pair by pair, and the
//    engine's own recovery path reads it from `ctx.rs` exactly so.
let seenRootKeys, seenStackKeys
const partialRoot = (ctx) => { for (let d = 0; d < ctx.rsI; d++) { const n = ctx.rs[d] && ctx.rs[d].node; if (null != n && 'object' === typeof n) return n } }
const eager = new Tabnas().use(jsonic).use(Expr, {
  op,
  evaluate: (rule, ctx, o, terms) => {
    seenRootKeys = ctx.root().node && Object.keys(ctx.root().node)
    const partial = partialRoot(ctx)
    seenStackKeys = partial && Object.keys(partial)
    return resolve(partial)(rule, ctx, o, terms)
  },
})
const eagerOut = eager.parse(src)
console.log('eager: ctx.root().node keys when @Pet closed:', JSON.stringify(seenRootKeys), '; outermost stack node keys:', JSON.stringify(seenStackKeys))
console.log('eager: paths./pets.get.schema =', JSON.stringify(eagerOut.paths['/pets'].get.schema), '(the target is parsed later)')

// 2. deferred: parse to an op tree, then fold it with the finished root.
const lazy = new Tabnas().use(jsonic).use(Expr, { op })
const tree = lazy.parse(src)
console.log('deferred: op tree  =', JSON.stringify(simplify(tree).paths['/pets'].get.schema))
const folded = evaluation(null, null, tree, resolve(tree))
console.log('deferred: evaluation() over the ROOT returns:', JSON.stringify(folded === tree ? '<the same root object>' : folded))
console.log('deferred: ...and the op inside the map is', JSON.stringify(simplify(folded.paths['/pets'].get.schema)),
  '(evaluation does not descend into objects)')
const direct = evaluation(null, null, tree.paths['/pets'].get.schema, resolve(tree))
console.log('deferred: evaluation() on the op node itself:', JSON.stringify(direct))

// 3. a same-document BACKWARD reference resolves eagerly through the stack:
//    eager evaluation sees exactly what precedes the site, and nothing after.
const back = eager.parse(`{ components: { schemas: { Pet: { type: object } } }, paths: { "/pets": { get: { schema: @Pet } } } }`)
console.log('eager, components first: outermost stack node keys:', JSON.stringify(seenStackKeys), '; schema =', JSON.stringify(back.paths['/pets'].get.schema))
