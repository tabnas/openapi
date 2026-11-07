# Rust crate `tabnas-openapi`

The Rust port of `@tabnas/openapi`: a plugin for the
[`tabnas`](https://github.com/tabnas/parser) parsing engine that reads
[OpenAPI](https://spec.openapis.org/oas/latest.html) and Swagger
descriptions, in YAML or in JSON, with one parser for both. The crate is
`tabnas-openapi`; the library is `tabnas_openapi`.

This release returns the raw tree: the document as written, with every
`$ref` kept as a reference. It does not yet check the document or resolve
its references.

## Set up

The crate takes the engine and the grammars it composes by path, from
sibling checkouts of [parser](https://github.com/tabnas/parser),
[json](https://github.com/tabnas/json),
[jsonic](https://github.com/tabnas/jsonic) and
[yaml](https://github.com/tabnas/yaml), and its tests also take
[support](https://github.com/tabnas/support) and
[debug](https://github.com/tabnas/debug). Clone each next to this
repository. Rust 1.85 or later.

## Read a description

`make` builds a parser with everything installed. It reads YAML and JSON:

```rust
let parser = tabnas_openapi::make();

let doc = parser.parse("openapi: 3.1.0\ninfo:\n  title: Pets\n  version: \"1\"\npaths: {}")?;
assert_eq!(
    doc.to_string(),
    r#"{"openapi":"3.1.0","info":{"title":"Pets","version":"1"},"paths":{}}"#
);

let doc = parser.parse(r#"{"openapi":"3.1.0","paths":{}}"#)?;
assert_eq!(doc.to_string(), r#"{"openapi":"3.1.0","paths":{}}"#);
# Ok::<(), tabnas_openapi::OpenApiError>(())
```

Build it once and keep it. Building the grammar costs more than a parse.

## References stay as written

```rust
let parser = tabnas_openapi::make();
let doc = parser.parse("parameters:\n  - $ref: '#/components/parameters/Limit'")?;
assert_eq!(
    doc.to_string(),
    r##"{"parameters":[{"$ref":"#/components/parameters/Limit"}]}"##
);
# Ok::<(), tabnas_openapi::OpenApiError>(())
```

The reference is quoted because YAML insists: an unquoted `#` after a
space starts a comment. YAML also reads `3.1` as a number, so quote a
version to keep it a string.

## Strict JSON

`MakeOptions::strict` reads JSON alone, by RFC 8259, and refuses
anything else with an error whose `code` names the failure:

```rust
use tabnas_openapi::{make_with, MakeOptions};

let strict = make_with(&MakeOptions { strict: true });
assert_eq!(strict.parse(r#"{"paths":{}}"#)?.to_string(), r#"{"paths":{}}"#);

let err = strict.parse("openapi: 3.1.0").unwrap_err();
assert_eq!(err.code, "unexpected");
assert_eq!((err.row, err.col), (1, 1));
# Ok::<(), tabnas_openapi::OpenApiError>(())
```

Test the code, not the message. The message is written for people and
can change wording.

## Install the plugin yourself

`make` is a shortcut for installing the yaml grammar and then the
plugin:

```rust
let mut parser = tabnas_yaml::make();
parser.use_plugin(tabnas_openapi::plugin(), None)?;
assert_eq!(parser.parse("paths:\n  /pets: {}")?.to_string(), r#"{"paths":{"/pets":{}}}"#);
# Ok::<(), Box<dyn std::error::Error>>(())
```

## The tree

A parse returns a `tabnas::Value`. A mapping is an object with its
members in document order, a sequence an array, a number an `f64`, and
`to_string` writes the tree as compact JSON. The TypeScript package is
canonical, and the shared fixtures run in every runtime, so the tree
here is the tree the TypeScript and Go packages give.

## License

MIT.
