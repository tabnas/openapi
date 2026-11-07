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
which references to inline. Each would have to undo resolution if the parser
had already done it.

## Resolution is a separate pass

Resolving a reference means replacing it with what it names. That cannot
happen while the text is being read: a reference can point forward, into
another file, or back at itself, and a grammar sees the text once, in
order.

So resolution belongs after the parse, as a pass over the finished tree
that visits every reference and works out its target. This release
stops before that pass. The tree it returns is the input the pass needs.

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
