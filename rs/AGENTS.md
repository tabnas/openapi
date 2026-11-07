# Agents Guide: rs/

The Rust port of the canonical TypeScript in [`../ts`](../ts). Read
[`../AGENTS.md`](../AGENTS.md) first: it holds the cross-runtime rules,
and this file only covers what is specific to this crate.

## Layout

| Path | |
|---|---|
| `src/lib.rs` | `VERSION`, `OpenApiError`, `OpenApiOptions`, the `openapi` installer and its `plugin()` form, `MakeOptions`, `make` and `make_with` |
| `tests/parity_test.rs` | every `../test/spec/*.tsv` fixture through `tabnas_support::Runner::new_with_row`, a fresh parser per row from its `opts` column |
| `tests/openapi_test.rs` | the crate surface: the petstore in both forms, strict refusing YAML, `make` against `tabnas_yaml::make`, strict against `tabnas_json::make`, the plugin installed by hand |
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
- **The lockfile is committed.** `ci/rust/run.sh` compares the whole
  resolution before and after cargo runs, exempting only the sibling
  crates' recorded versions, so a new third-party crate shows up as a
  red gate until `rs/Cargo.lock` is committed with it.
