/* Copyright (c) 2025-2026 Richard Rodger, MIT License */

// The engine's error carries a code, position, hint and a formatted
// report, so it is large by design and `Result<_, TabnasError>` trips
// clippy's `result_large_err`. The engine and the jsonic crate allow the
// lint at their own roots for the same reason; boxing here would make
// `parse` return a different shape from `Tabnas::parse`.
#![allow(clippy::result_large_err)]

//! OpenAPI and Swagger documents, in JSON or YAML, for the `tabnas`
//! parsing engine.
//!
//! The plugin installs on a jsonic instance that carries the yaml grammar,
//! so one parser reads both serialisations, or, with
//! [`MakeOptions::strict`], on the strict json grammar alone. Raw mode, the
//! document exactly as written, is the engine's own parse.
//!
//! ```
//! let parser = tabnas_openapi::make();
//! let value = parser.parse("openapi: 3.1.0\npaths: {}")?;
//! assert_eq!(value.to_string(), r#"{"openapi":"3.1.0","paths":{}}"#);
//! # Ok::<(), tabnas_openapi::OpenApiError>(())
//! ```
//!
//! TypeScript is canonical: `ts/src/openapi.ts` defines behaviour. The
//! shared fixtures in `test/spec/*.tsv` are the parity contract across
//! TypeScript, Go and Rust. The plan for the rest is
//! `docs/design/implementation-plan.md`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tabnas::{Plugin, PluginError, Tabnas, Value};

/// This crate's version. It MUST equal `ts/package.json` "version": the
/// release orchestrator rewrites both, and `tests/version_test.rs` fails
/// the build if they drift. Mirrors `VERSION` in `ts/src/openapi.ts` and
/// `const VERSION` in `go/openapi.go`.
pub const VERSION: &str = "0.1.0";

/// The README's Rust examples run as doctests, so a stale one fails the
/// gate rather than misleading the reader. Its `toml` and `bash` fences
/// are skipped; rustdoc runs only the `rust` ones.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
mod readme_examples {}

/// The error a failed parse produces, re-exported so callers need not
/// depend on the engine crate directly.
pub use tabnas::TabnasError as OpenApiError;

/// The plugin's name, as the canonical plugin's function name.
const PLUGIN_NAME: &str = "OpenApi";

/// Plugin options. There are none yet: raw mode needs none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenApiOptions {}

impl OpenApiOptions {
    /// The options as the engine's plugin option bag.
    #[must_use]
    pub fn to_value(self) -> Value {
        Value::object(IndexMap::new())
    }
}

/// The plugin installer. It installs after the base grammar and records
/// nothing on the parsed tree. Mirrors `OpenApi` in `ts/src/openapi.ts`.
///
/// ```
/// let mut parser = tabnas_yaml::make();
/// tabnas_openapi::openapi(&mut parser, &tabnas_openapi::OpenApiOptions::default())?;
/// assert_eq!(parser.parse("paths:\n  /pets: {}")?.to_string(), r#"{"paths":{"/pets":{}}}"#);
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
pub fn openapi(_parser: &mut Tabnas, _options: &OpenApiOptions) -> Result<(), PluginError> {
    // Installs, and changes nothing yet.
    Ok(())
}

/// The plugin form of [`openapi`], for [`Tabnas::use_plugin`].
pub fn plugin() -> Plugin {
    Plugin::new(PLUGIN_NAME, |parser, _options| {
        openapi(parser, &OpenApiOptions::default())
    })
    .with_defaults(OpenApiOptions::default().to_value())
}

/// Options for [`make_with`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MakeOptions {
    /// Read strict JSON (RFC 8259) with the json grammar alone, instead
    /// of JSON and YAML with jsonic and the yaml grammar.
    pub strict: bool,
}

/// A parser with the plugin installed: jsonic with the yaml grammar,
/// which reads JSON text as the strict json grammar does and YAML
/// besides, or, with [`MakeOptions::strict`], json alone. Mirrors `make`
/// in `ts/src/openapi.ts`.
///
/// Reuse the result: building the grammar dominates a parse.
///
/// Infallible by design: the grammars are fixed, so a failure here is a
/// bug in a crate rather than anything a caller did.
///
/// ```
/// let strict = tabnas_openapi::make_with(&tabnas_openapi::MakeOptions { strict: true });
/// assert_eq!(strict.parse(r#"{"openapi":"3.1.0"}"#)?.to_string(), r#"{"openapi":"3.1.0"}"#);
/// assert!(strict.parse("openapi: 3.1.0").is_err());
/// # Ok::<(), tabnas_openapi::OpenApiError>(())
/// ```
#[must_use]
pub fn make_with(options: &MakeOptions) -> Tabnas {
    let mut parser = if options.strict {
        tabnas_json::make()
    } else {
        // The construction `tabnas_yaml::make` makes, spelled out so that
        // this crate depends on jsonic directly, as the TypeScript and Go
        // ports do. `tests/openapi_test.rs` holds the two together.
        let mut parser = tabnas_jsonic::make();
        parser
            .use_plugin(tabnas_yaml::plugin(), None)
            .expect("the yaml grammar documents are fixed and valid");
        parser
    };
    parser
        .use_plugin(plugin(), None)
        .expect("the openapi plugin installs on any instance");
    parser
}

/// A parser with the plugin installed and the default options.
///
/// ```
/// let parser = tabnas_openapi::make();
/// let value = parser.parse(r#"{"paths":{"/pets":{"get":{}}}}"#)?;
/// assert_eq!(value.to_string(), r#"{"paths":{"/pets":{"get":{}}}}"#);
/// # Ok::<(), tabnas_openapi::OpenApiError>(())
/// ```
#[must_use]
pub fn make() -> Tabnas {
    make_with(&MakeOptions::default())
}
