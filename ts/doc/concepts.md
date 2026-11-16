# Concepts

Why `@tabnas/openapi` reads descriptions the way it does. The
[reference](reference.md) states what it does; this page argues for it.

## One parser for two serialisations

OpenAPI descriptions are written in YAML or in JSON, and the filename is
only a hint. A tool that guesses the format from the extension
eventually guesses wrong.

So the default parser does not guess. It is the jsonic grammar with the
yaml grammar installed over it, and JSON text is also YAML: a JSON
document reads to the same tree under it as under a strict JSON grammar.
One parser, both formats, no sniffing.

The cost is leniency. A grammar that reads YAML reads plenty that JSON
forbids, and the jsonic grammar beneath it reads more again: a trailing
comma, an unquoted key, a comment. For a description you only consume,
that leniency is a convenience. For a description you publish, it hides
mistakes another tool will refuse.

That is what `strict` is for. It swaps the base grammar for the JSON
grammar alone, which follows RFC 8259 and refuses everything else.
Validate with it before you publish; read with the default.

## The raw tree

A parse returns the document as written. Every `$ref` stays a reference,
every member keeps its place, and nothing is fetched or followed.

The raw tree comes first because several kinds of tool need exactly it.
An editor or a linter reports problems where the author wrote them. A
formatter writes the document back. A bundling tool decides for itself
which references to inline. Each would have to undo resolution if the
parser had already done it.

## Checks the grammar cannot make

A grammar reads text. It does not know that the text is meant to be an
OpenAPI description, so it reads a list, a lone string, or a stream of
three YAML documents as happily as a map. `parse` knows, and refuses
each of them with a code of its own.

The checks run inside the engine's parse, as each rule finishes, so an
error carries the engine's row and column and a hint like any other. They
run only when `parse` asks for them. The `parse` method of a parser from
`make` stays the plain grammar, which is what a tool that wants the
document whatever its shape should call.

`strict` adds two more: a version this package reads, and each member
name once per map. Both are about publishing, not reading, which is why
they come with the strict grammar.

## Two paths, one tree

Most large descriptions are JSON, and `JSON.parse` reads JSON two orders
of magnitude faster than a grammar can. So `parse` gives JSON text that
opens with `{` to `JSON.parse` first, and to the grammar only when
`JSON.parse` refuses it.

Two readers are a promise as much as a speed-up: the tree must not depend
on which one read it. Three things make that hold. The fast path rebuilds
every map without a prototype, as the grammar builds them, so a member
named `__proto__` is data on both. A repeated member name keeps its last
value on both, because the plugin tells the grammar to do what
`JSON.parse` does. And every refusal comes from the grammar, because the
fast path gives up rather than raise anything.

## Repeated names

YAML forbids a map from holding one name twice, JSON leaves it
undefined, and readers disagree. `JSON.parse` keeps the last value. The
grammars beneath this package merged two maps given under one name,
which the common JSON and YAML readers do not.

The plugin picks the reading most tools share: the last value wins,
whole, at the place where the name first appeared. Under `strict` a
repeated name is an error, since a description meant for other tools
should not depend on which one reads it.

The merge is still there for a caller that asks for it. A tool whose
descriptions were written for the merging reader passes
`duplicates: 'merge'`, and gets the merge the grammars make by
themselves. That is a choice made for one parse. The default stays the
last value.

## Resolution is a separate pass

Resolving a reference means replacing it with what it names. That cannot
happen while the text is being read: a reference can point forward, into
another file, or back at itself, and a grammar sees the text once, in
order.

So resolution belongs after the parse, as a pass over the finished tree
that visits every reference and works out its target. That pass is
`resolve`, and it leaves the raw tree alone: the tools that want the
document as written still have it.

## What is a reference

Not every map that owns `$ref` is a reference. An example payload can
hold one, an extension value can, and a schema can have a property
named `$ref`. A resolver that followed all of them would rewrite data.

So `resolve` asks what each position holds, by the description's
version: a Reference Object, a Schema Object, a Path Item, or data. The
answer comes from a table generated from the OpenAPI Initiative's own
validation schemas for 2.0, 3.0, 3.1 and 3.2, not from a list of names
someone remembered.

## A graph, not a tree

Ten operations can name one response. `resolve` builds that response
once and, by default, puts the same object in all ten places, so the
result is a graph that shares its nodes, and building it costs one pass
over the document however often a target is named.

Sharing is cheap in memory and dear on paper. JSON writes a shared value
out once for every place it appears, so a description whose schemas name
schemas can grow past any size a file should have. The shape is
therefore a choice, `sharing`:

- `share` keeps one value per target, the cheapest, for a program that
  walks objects.
- `site` gives each site its own shallow copy, so a tool can write on a
  site without writing on its target.
- `inline-once` puts each target's value at the first site that names
  it and leaves the rest as references. The result is a tree no larger
  than a small multiple of the document, which is what to write to a
  file or to diff.
- `copy` writes every value out at every site. It is the shape most
  tools expect and can be very large, so it asks for a budget and stops
  there.

A cycle needs a decision too. A schema for a linked list names itself,
and replacing that reference with its target would never end. By
default `resolve` cuts each cycle once, at the reference whose target
was still being built when the walk reached it, leaves that reference as
written, and lists it in `cuts`. The walk runs from the root in document
order, so a description gives the same cuts every time. `cycles: 'keep'`
follows that edge instead, so the list's `next` is the list itself: a
graph with a loop in it, which a program can walk and JSON cannot write.

## Names that are not references

A `$ref` is not the only way a description points at another part of
itself. A Link names an operation by its `operationId`, a Security
Requirement names security schemes by its member names, an operation
names its tags, and a Discriminator maps payload values to schemas. None
of these is replaced by what it names: the specification reads each in
its own way, and a tool that put the target in its place would change
what the document says.

So `resolve` reports them, in `connections`, and leaves the tree alone.
Each row says what the name reaches, if anything, which makes the checks
a careful reader makes by hand mechanical: that a tag is declared, that
a 3.2 tag's parents do not loop, that one `operationId` names
one operation however many paths reach it. A 3.2 Security Requirement may
name a scheme by URI as well as by name, and a name that is also a URI
to another scheme is flagged, since which reading a tool takes decides
who may call the operation.

## Matching another resolver

`@voxgig/apidef` resolves references with one rule for every site: the
target's members with the site's own laid over them, and `x-ref` beside
them, in every position, data included. It reads a reference one way
too, as a pointer from the root of the document, so an anchor or a URI
names nothing. `compat: 'apidef'` is that resolver as a set of options,
and it gives the same tree, member for member, with the same objects
shared. A tool that moves from one resolver to the other can keep its
output as it was, then turn the options back to the specification's
reading one at a time, measuring each step.

## YAML decides types

YAML gives an unquoted scalar a type by how it looks. Most of the time
that is what an author meant. A few cases matter for OpenAPI:

- A version written `3.1` is a number, and a number is not a version
  string. `3.1.0` is safe, because it is not a number.
- A `$ref` value starts with `#`, and an unquoted `#` after a space
  starts a comment, so the reference disappears.
- A response code written `200` is a number in YAML. The tree's object
  keys are strings either way, but quoting it, `'200'`, says so.

The parser follows YAML here rather than second-guessing it. The
[how-to guide](guide.md#keep-a-value-yaml-would-change) shows the
quoting that keeps a value as text.
