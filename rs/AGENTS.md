# Agents Guide: rs/

The Rust port of the canonical TypeScript in [`../ts`](../ts). Read
[`../AGENTS.md`](../AGENTS.md) first: it holds the cross-runtime rules,
and this file only covers what is specific to this crate.

## Layout

| Path | |
|---|---|
| `src/lib.rs` | `VERSION`, `OpenApiError`, `OpenApiOptions`, the `openapi` installer and its `plugin()` form, `MakeOptions`, `make` and `make_with`; raw mode: `parse` with `ParseOptions` and `Fast`, the checks behind it, the `serde_json` fast path, and `version` with `VersionInfo`; unit tests of the private helpers |
| `tests/parity_test.rs` | every `../test/spec/*.tsv` fixture through `parse` with the row's `opts`, and `raw-fast.tsv` twice more with the fast path forced on and off |
| `tests/openapi_test.rs` | the crate surface: the petstore in both forms, strict refusing YAML, `make` against `tabnas_yaml::make`, strict against `tabnas_json::make`, the plugin installed by hand; raw mode, the Rust half of the "raw mode" block of `ts/test/openapi.test.ts`, with the places Rust differs from TypeScript measured and pinned |
| `tests/debug_model_test.rs` | the plugin composed with `tabnas-debug`: the grammar model of `make()` equals that of `tabnas_yaml::make()`, and strict's that of `tabnas_json::make()` |
| `tests/version_test.rs` | `Cargo.toml` == `VERSION` == `ts/package.json` |
| `tests/common/mod.rs` | shared helpers: repo root, spec dir, value and failure conversion, the `opts` reader, integral numbers for comparison |
| `README.md` | the crate front page, prose-gated; its `rust` fences are doctests of this crate |

Crate `tabnas-openapi`, library `tabnas_openapi`. The engine (`tabnas`,
package `tabnas-parser`), the grammars (`tabnas-json`, `tabnas-jsonic`,
`tabnas-yaml`), the fixture runner (`tabnas-support`, dev only) and the
introspection plugin (`tabnas-debug`, dev only) are **path dependencies
on sibling checkouts** (`../../parser/rs`, `../../json/rs`,
`../../jsonic/rs`, `../../yaml/rs`, `../../support/rs`,
`../../debug/rs`). They are on crates.io, but the committed manifest
names them by path alone.

```bash
cargo build --all-targets
cargo test --all-targets && cargo test --doc
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt
```

`make test-rs` from the repository root is the fast loop; `ci/rust/run.sh`
is the gate CI runs, and the only one that checks formatting, the
lockfile and the MSRV.

## Notes

- **The default instance is spelled out, not borrowed.** `make_with`
  builds `tabnas_jsonic::make()` and installs `tabnas_yaml::plugin()`
  rather than calling `tabnas_yaml::make()`, so that this crate depends
  on jsonic directly, as the other ports do; `tools/port-deps.cjs`
  compares the three. `make_matches_tabnas_yaml_make` holds the two
  constructions together.
- **Strict is `tabnas_json::make()`,** which also sets `lex.window` for
  parsing from a reader. A string parse is unaffected.
- **The yaml plugin is named `yaml` here** and `Yaml` in TypeScript.
- **Numbers are `f64`.** `Value::to_json` writes `1.0` for a whole
  number, so the tests compare through `common::integral_numbers`, and
  `Value::to_string` writes `1`, as the other runtimes print it.
- **The README is doctested** through `#[cfg(doctest)]` in `src/lib.rs`.
  A `rust` fence there is a test; a string holding `"#` needs the
  `r##"..."##` form.
- **The checks cannot throw, so they record and stop.** TypeScript's
  `check` is a ruleDone subscriber that counts documents on the state
  `parse` passes as parse metadata and throws. Here a ruleDone
  subscriber returns nothing and is handed `&Context`, and the metadata
  is a `Value`, which holds no interior mutability. So `parse` passes
  the fixed part of its state (`strict`, `empty`, an id) through
  `Tabnas::parse_with_meta`, the changing part (the document count, the
  root's first token, the error) sits in a thread-local table under the
  id, a check records its error there, the plugin's parse guard
  `openapi` stops the parse at the next step with `cancel`, and `parse`
  returns the recorded error in its place. The error is built as the
  engine builds one (`TabnasError::new` and `attach_context`), at the
  token TypeScript places it at; the colour, link and instance-tag parts
  of its rendered report are the engine's defaults, since the engine
  applies an instance's `errmsg` options only to errors it raises
  itself. Unwinding with the error as the payload, which the engine also
  turns back into the error, was not used: under `panic = "abort"` it
  would end the host process on an invalid document.
- **The fast path reads numbers itself.** `serde_json` checks the text
  and decodes its strings, but each number is read from its own text
  with `str::parse::<f64>`, as the grammar's lexer reads it.
  `serde_json`'s own float reading is exact only with `float_roundtrip`,
  which this crate's dev-dependencies switch on and a build of the
  library alone does not, so the tests could not see the difference.
- **The lockfile is committed.** `ci/rust/run.sh` compares the whole
  resolution before and after cargo runs, exempting only the sibling
  crates' recorded versions, so a new third-party crate shows up as a
  red gate until `rs/Cargo.lock` is committed with it.
