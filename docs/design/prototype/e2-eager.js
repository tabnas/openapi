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
let seenRootKeys
const eager = new Tabnas().use(jsonic).use(Expr, {
  op,
  evaluate: (rule, ctx, o, terms) => {
    const root = ctx.root().node
    seenRootKeys = root && Object.keys(root)
    return resolve(root)(rule, ctx, o, terms)
  },
})
const eagerOut = eager.parse(src)
console.log('eager: root keys visible when @Pet closed:', JSON.stringify(seenRootKeys))
console.log('eager: paths./pets.get.schema =', JSON.stringify(eagerOut.paths['/pets'].get.schema))

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

// 3. a same-document BACKWARD reference works eagerly — order dependence.
const back = eager.parse(`{ components: { schemas: { Pet: { type: object } } }, paths: { "/pets": { get: { schema: @Pet } } } }`)
console.log('eager, components first: schema =', JSON.stringify(back.paths['/pets'].get.schema))
