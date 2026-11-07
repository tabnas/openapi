# Go concepts

Why the Go package reads descriptions the way it does. The
[reference](reference.md) states what it does; this page argues for it.
The TypeScript package is the canonical one, and the Go port gives the
same tree for the same text.

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
that is a convenience. For a description you publish, it hides mistakes
another tool will refuse. `Strict` swaps the base grammar for the JSON
grammar alone, which follows RFC 8259 and refuses everything else.

## The raw tree, in order

A parse returns the document as written. Every `$ref` stays a reference,
and nothing is fetched or followed. An editor reports problems where the
author wrote them, a formatter writes the document back, and a bundling
tool decides for itself which references to inline: each needs the tree
before resolution.

A mapping comes back as a `*tabnas.OrderedMap` rather than a Go map
because a Go map forgets order. Member order is part of what an author
wrote, and a reader expects the paths of an API in that order.

## Checks the grammar cannot make

A grammar reads text. It does not know that the text is meant to be an
OpenAPI description, so it reads a list, a lone string, or a stream of
three YAML documents as happily as a map. `Parse` knows, and refuses
each of them with a code of its own. The checks run inside the engine's
parse, as each rule finishes, so an error carries the engine's row and
column and a hint like any other. The `Parse` method of a parser from
`Make` stays the plain grammar, for a tool that wants the document
whatever its shape.

## Two paths, one tree

`encoding/json` reads JSON several times faster than a grammar can, so
`Parse` gives JSON text that opens with `{` to `encoding/json` first, and
to the grammar only when that refuses it. The fast path decodes into the
same `*tabnas.OrderedMap` the grammar builds, and a repeated member name
keeps its last value on both paths, at the place where the name first
appeared. Every refusal comes from the grammar, because the fast path
gives up rather than raise anything.

## Parsers and goroutines

The yaml grammar keeps the state of a parse on the parser it is
installed on, so a parser runs one parse at a time. `Parse` keeps a pool
of parsers and takes one per call, which is why it is safe from many
goroutines at once and a parser you pass it is not.

## Resolution is a separate pass

Resolving a reference means replacing it with what it names. That cannot
happen while the text is being read: a reference can point forward, into
another file, or back at itself, and a grammar sees the text once, in
order. So resolution belongs after the parse, as a pass over the
finished tree. This release stops before that pass.

## YAML decides types

YAML gives an unquoted scalar a type by how it looks. A version written
`3.1` is a number, and an unquoted `#` after a space starts a comment,
which swallows a `$ref`. The parser follows YAML here rather than
second-guessing it; quote a value that must stay text.
