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
//! document exactly as written, is the engine's own parse; [`parse`] adds
//! the checks the engine cannot make (the root, a stream of several
//! documents, and under [`ParseOptions::strict`] the version and repeated
//! member names) and a fast path for JSON text.
//!
//! ```
//! use tabnas_openapi::{parse, version, ParseOptions};
//!
//! let doc = parse("openapi: 3.1.0\npaths: {}", &ParseOptions::default())?;
//! assert_eq!(doc.to_string(), r#"{"openapi":"3.1.0","paths":{}}"#);
//! assert_eq!(version(&doc).version, "3.1");
//!
//! let err = parse("- a\n- b", &ParseOptions::default()).unwrap_err();
//! assert_eq!(err.code, "openapi_root");
//!
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

use std::cell::{Cell, RefCell};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use indexmap::IndexMap;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use tabnas::error::ErrorToken;
use tabnas::{
    Context, Plugin, PluginError, Rule, RuleDone, RuleState, Tabnas, Token, Value, TIN_ZZ,
};

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

/// Set on an instance by [`openapi`], which is how [`parse`] tells an
/// instance with the plugin from one without. A decoration rather than
/// the plugin list, because [`openapi`] called directly installs the
/// checks without entering that list.
const INSTALLED: &str = "openapi-installed";

/// The name of the parse guard that stops a parse once a check has
/// failed in it (see [`keep_going`]).
const GUARD: &str = "openapi";

/// The key `parse` puts its per-parse state under in the parse metadata,
/// as TypeScript's `tn.parse(text, { openapi: state })`.
const META: &str = "openapi";

const ROOT: &str = "openapi_root";
const STREAM: &str = "openapi_stream";
const VERSION_CODE: &str = "openapi_version";
const DUPLICATE_KEY: &str = "openapi_duplicate_key";

/// The error codes the plugin raises, with their messages. A placeholder
/// in braces is filled from the error's details. Member names in a
/// message are document content, so they arrive JSON-quoted and cut short
/// (see [`quoted`]). The texts are `ERRORS` in `ts/src/openapi.ts`.
const ERRORS: [(&str, &str); 4] = [
    (
        ROOT,
        "the document is {kind} at its root, where an OpenAPI description is a map",
    ),
    (
        STREAM,
        "the text holds more than one YAML document, where a description is one",
    ),
    (
        VERSION_CODE,
        "the root names no OpenAPI or Swagger version this package reads ({found})",
    ),
    (
        DUPLICATE_KEY,
        "the member name {key} appears twice in one map",
    ),
];

/// The hints for [`ERRORS`], as `HINTS` in `ts/src/openapi.ts`.
const HINTS: [(&str, &str); 4] = [
    (
        ROOT,
        "Put the members of the description, such as openapi, info and paths, \
         at the top level of the document.",
    ),
    (
        STREAM,
        "Split the stream at each --- line and parse each document on its own.",
    ),
    (
        VERSION_CODE,
        "Set openapi to a 3.0, 3.1 or 3.2 version string, such as \"3.1.0\", \
         or swagger to \"2.0\".",
    ),
    (
        DUPLICATE_KEY,
        "Remove or rename one of the two members. JSON readers disagree on \
         which of them to keep.",
    ),
];

/// Plugin options. There are none: raw mode needs none, and the
/// resolver's options will belong to resolution rather than to the
/// plugin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenApiOptions {}

impl OpenApiOptions {
    /// The options as the engine's plugin option bag.
    #[must_use]
    pub fn to_value(self) -> Value {
        Value::object(IndexMap::new())
    }
}

/// The plugin installer. Mirrors `OpenApi` in `ts/src/openapi.ts`.
///
/// It installs after the base grammar, adds no rule, and records nothing
/// on the parsed tree. It declares the plugin's error codes with their
/// messages and hints, makes a repeated member name keep its last value
/// whole (the engine's `map.merge` option, which the jsonic and yaml
/// grammars call on a repeated name), and subscribes to rule completion
/// for the checks [`parse`] asks for. A parse that [`parse`] did not
/// start, `parser.parse(text)`, is the engine's own, and the plugin
/// raises nothing in it.
///
/// ```
/// let mut parser = tabnas_yaml::make();
/// tabnas_openapi::openapi(&mut parser, &tabnas_openapi::OpenApiOptions::default())?;
/// assert_eq!(parser.parse("paths:\n  /pets: {}")?.to_string(), r#"{"paths":{"/pets":{}}}"#);
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
pub fn openapi(parser: &mut Tabnas, _options: &OpenApiOptions) -> Result<(), PluginError> {
    // Once per instance: a second subscriber would count every YAML
    // document twice and refuse a single document as a stream.
    if parser.decoration::<bool>(INSTALLED).is_some() {
        return Ok(());
    }
    parser.set_options(|options| {
        for (code, message) in ERRORS {
            options.error.insert(code.to_string(), message.to_string());
        }
        for (code, hint) in HINTS {
            options.hint.insert(code.to_string(), hint.to_string());
        }
        // The last value of a repeated name wins, whole, as JSON.parse
        // has it: the base grammars would otherwise merge two maps given
        // under one name.
        options.map.merge = Some(Arc::new(|_previous, current, _rule, _context| current));
    })?;
    parser.subscribe_rule_done(check);
    parser.parse_guard(GUARD, keep_going);
    parser.decorate(INSTALLED, true);
    Ok(())
}

/// The plugin form of [`openapi`], for [`Tabnas::use_plugin`]. Installed
/// this way the plugin is installed again on a derived instance, as every
/// native plugin is.
///
/// ```
/// let mut parser = tabnas_yaml::make();
/// parser.use_plugin(tabnas_openapi::plugin(), None)?;
/// let doc = tabnas_openapi::parse(
///     "openapi: 3.1.0",
///     &tabnas_openapi::ParseOptions { instance: Some(&parser), ..Default::default() },
/// )?;
/// assert_eq!(doc.to_string(), r#"{"openapi":"3.1.0"}"#);
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
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
    let base = if options.strict {
        tabnas_json::make()
    } else {
        // The construction `tabnas_yaml::make` makes, spelled out so that
        // this crate depends on jsonic directly, as the TypeScript and Go
        // ports do. `tests/openapi_test.rs` holds the two together.
        tabnas_jsonic::make()
    };
    make_on(base, options)
}

/// Install the format's grammar (the yaml grammar on jsonic's base, or
/// none on json's) and this plugin on `parser`, and declare this parser's
/// own window setting: `lex.window` false, so that
/// [`Tabnas::parse_reader`] reads a reader whole (admin ADR-30). The
/// plugin is not yet verified at the window's edge, and a base that
/// declares the window must not carry it to it; the setting comes last,
/// after everything the base and the plugins set.
fn make_on(mut parser: Tabnas, options: &MakeOptions) -> Tabnas {
    if !options.strict {
        parser
            .use_plugin(tabnas_yaml::plugin(), None)
            .expect("the yaml grammar documents are fixed and valid");
    }
    parser
        .use_plugin(plugin(), None)
        .expect("the openapi plugin installs on any instance");
    parser
        .set_options(|options| options.lex.window = false)
        .expect("lex.window sets");
    parser
}

#[cfg(test)]
mod window_tests {
    use super::MakeOptions;

    /// The parser's own setting wins over its base's: a base that declares
    /// `lex.window`, as jsonic's and json's own constructors may, given
    /// the constructor's steps, comes out with the window off, in either
    /// mode.
    #[test]
    fn a_windowed_base_comes_out_without_the_window() {
        for strict in [false, true] {
            let mut base = if strict {
                tabnas_json::make()
            } else {
                tabnas_jsonic::make()
            };
            base.set_options(|options| options.lex.window = true)
                .expect("lex.window sets");
            assert!(base.options.lex.window);
            let parser = super::make_on(base, &MakeOptions { strict });
            assert!(!parser.options.lex.window, "strict {strict}");
            assert!(parser.parse(r#"{"openapi": "3.1.0", "paths": {}}"#).is_ok());
        }
    }
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

// ---------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------

/// When [`parse`] reads JSON text with `serde_json` rather than the
/// grammar. Whichever reads it, the tree is the same; the fast path only
/// saves time, and it falls back to the grammar on anything it refuses,
/// so every error still comes from the grammar.
///
/// It reads from the fixtures' `opts` JSON as TypeScript's `fast` option
/// is written: `true`, `false` or `"auto"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Fast {
    /// Take the fast path when the first character that is not JSON
    /// whitespace (space, tab, line feed, carriage return) is `{`. The
    /// default.
    #[default]
    Auto,
    /// Take the fast path whatever the text opens with.
    On,
    /// Never take the fast path.
    Off,
}

impl Fast {
    /// Whether to try the fast path on `text`.
    fn takes(self, text: &str) -> bool {
        match self {
            Fast::Auto => text
                .trim_start_matches([' ', '\t', '\n', '\r'])
                .starts_with('{'),
            Fast::On => true,
            Fast::Off => false,
        }
    }
}

impl From<bool> for Fast {
    /// `true` is [`Fast::On`] and `false` [`Fast::Off`], as in TypeScript.
    fn from(on: bool) -> Self {
        if on {
            Fast::On
        } else {
            Fast::Off
        }
    }
}

impl<'de> Deserialize<'de> for Fast {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FastVisitor;

        impl Visitor<'_> for FastVisitor {
            type Value = Fast;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(r#"true, false or "auto""#)
            }

            fn visit_bool<E: de::Error>(self, on: bool) -> Result<Fast, E> {
                Ok(Fast::from(on))
            }

            fn visit_str<E: de::Error>(self, text: &str) -> Result<Fast, E> {
                if text == "auto" {
                    Ok(Fast::Auto)
                } else {
                    Err(E::invalid_value(de::Unexpected::Str(text), &self))
                }
            }
        }

        deserializer.deserialize_any(FastVisitor)
    }
}

/// Options for [`parse`]. The default reads JSON and YAML with a shared
/// parser, takes the fast path for JSON text that opens with `{`, and
/// refuses only what is not one description with a map at its root.
///
/// It reads from the fixtures' `opts` JSON, such as `{"strict":true}` or
/// `{"fast":"auto"}`; the instance cannot come from JSON.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct ParseOptions<'a> {
    /// Read strict JSON alone, by RFC 8259, and refuse an unknown
    /// version (`openapi_version`) and a member name given twice in one
    /// map (`openapi_duplicate_key`). The fast path never runs under
    /// strict.
    pub strict: bool,
    /// When to read JSON text with `serde_json` rather than the grammar.
    pub fast: Fast,
    /// The parser to use, from [`make`], [`make_with`] or an instance
    /// with [`plugin`] installed. `None`, the default, uses one shared
    /// parser per setting of [`ParseOptions::strict`].
    #[serde(skip)]
    pub instance: Option<&'a Tabnas>,
}

impl fmt::Debug for ParseOptions<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ParseOptions")
            .field("strict", &self.strict)
            .field("fast", &self.fast)
            .field("instance", &self.instance.map(|parser| parser.id.as_str()))
            .finish()
    }
}

/// Parse a description and return its raw tree: the document as written,
/// every `$ref` kept as a reference. Mirrors `parse` in
/// `ts/src/openapi.ts`.
///
/// Refuses, with the error's `code`:
///
/// - `openapi_root` when the root is not a map, an empty text included;
/// - `openapi_stream` for a YAML stream of more than one document, at
///   the start of the second;
/// - under [`ParseOptions::strict`], `openapi_version` when the root
///   names no version [`version`] knows, and `openapi_duplicate_key` for
///   a member name given twice in one map, at the second;
/// - anything the grammar refuses, with the grammar's code.
///
/// An instance in [`ParseOptions::instance`] without the plugin is
/// refused with an `internal` error rather than one of these codes: it is
/// a mistake in the calling code, not in the text.
///
/// ```
/// use tabnas_openapi::{parse, ParseOptions};
///
/// let strict = ParseOptions { strict: true, ..Default::default() };
/// let doc = parse(r#"{"openapi":"3.1.0","paths":{}}"#, &strict)?;
/// assert_eq!(doc.to_string(), r#"{"openapi":"3.1.0","paths":{}}"#);
///
/// let err = parse(r#"{"openapi":"4.0.0"}"#, &strict).unwrap_err();
/// assert_eq!(err.code, "openapi_version");
///
/// let err = parse("openapi: 3.1.0\n---\nopenapi: 3.0.0", &ParseOptions::default()).unwrap_err();
/// assert_eq!((err.code.as_str(), err.row, err.col), ("openapi_stream", 3, 1));
/// # Ok::<(), tabnas_openapi::OpenApiError>(())
/// ```
pub fn parse(text: &str, options: &ParseOptions<'_>) -> Result<Value, OpenApiError> {
    let strict = options.strict;
    let parser = match options.instance {
        Some(parser) => parser,
        None => shared(strict),
    };
    if parser.decoration::<bool>(INSTALLED).is_none() {
        return Err(no_plugin());
    }

    if !strict && options.fast.takes(text) {
        if let Some(value) = fast_parse(text) {
            return Ok(value);
        }
    }

    // Strict JSON refuses an empty text itself, as `unexpected`. Otherwise
    // the engine returns at once for an empty text and runs no rule, so
    // the text is read as a single line break, which reads to an empty
    // document, and the state says what the reader wrote.
    let empty = text.is_empty() && !strict;
    let run = Run::start(strict, empty);
    let result = parser.parse_with_meta(if empty { "\n" } else { text }, run.state.to_meta());
    match run.finish() {
        Some(error) => Err(error),
        None => result,
    }
}

/// The parser [`parse`] uses when it is given none: one per setting of
/// `strict`, built on first use. `Tabnas::parse` takes `&self` and builds
/// its state per call, so one instance serves every thread.
fn shared(strict: bool) -> &'static Tabnas {
    static LOOSE: OnceLock<Tabnas> = OnceLock::new();
    static STRICT: OnceLock<Tabnas> = OnceLock::new();
    if strict {
        STRICT.get_or_init(|| make_with(&MakeOptions { strict: true }))
    } else {
        LOOSE.get_or_init(make)
    }
}

/// The refusal of an instance without the plugin. TypeScript throws a
/// plain `Error` with this message; the engine's error type needs a code,
/// and `internal` is the engine's own for a failure that is not the
/// text's.
fn no_plugin() -> OpenApiError {
    let mut error = OpenApiError::new("internal", "", "", 0, 1, 1);
    error.detail = "parse: the instance has no OpenApi plugin; build it with make()".into();
    error.hint = "Build the instance with make() or make_with(), or install plugin() on it.".into();
    error
}

// ---------------------------------------------------------------------
// The per-parse state
// ---------------------------------------------------------------------
//
// TypeScript hands the plugin one mutable object through the parse
// metadata, `tn.parse(text, { openapi: state })`, and the subscriber
// counts documents on it and throws. Neither carries over as it is:
//
// - The metadata is a `Value` (`Tabnas::parse_with_meta`, read back as
//   `Context::meta`), which holds no interior mutability, and a ruleDone
//   subscriber is handed `&Context`. So the metadata carries what does
//   not change, the strict and empty flags, with an id, and what does,
//   the document count, the root's first token and the error, lives in
//   a thread-local table under that id. The parse runs on the calling
//   thread, so the entry is this parse's alone, and a nested parse that
//   `parse` did not start carries no id and is left alone.
// - A ruleDone subscriber returns nothing. So a check records its error
//   in the table rather than throwing it, the plugin's parse guard
//   (`keep_going`) stops the parse at the next step, and `parse` returns
//   the recorded error in place of whatever the engine returned: the
//   guard's `cancel`, or, after the last pass, the result or a later
//   error. A check that fails on the root's last pass has no next step to
//   stop, which is where TypeScript stops too.

/// What does not change during a parse, carried in the parse metadata.
#[derive(Debug, Clone, Copy)]
struct ParseState {
    /// The key of this parse's entry in [`RUNNING`].
    id: u64,
    strict: bool,
    /// The text was empty; see [`parse`].
    empty: bool,
}

impl ParseState {
    /// The parse metadata: `{"openapi": {"id": .., "strict": .., "empty": ..}}`.
    fn to_meta(self) -> Value {
        // An id is a whole number far below 2^53, so the f64 holds it.
        let mut state = IndexMap::new();
        state.insert("id".to_string(), Value::Number(self.id as f64));
        state.insert("strict".to_string(), Value::Bool(self.strict));
        state.insert("empty".to_string(), Value::Bool(self.empty));
        let mut meta = IndexMap::new();
        meta.insert(META.to_string(), Value::object(state));
        Value::object(meta)
    }

    /// The state of the parse `context` belongs to, when `parse` started
    /// it.
    fn of(context: &Context) -> Option<Self> {
        let Value::Object(meta) = &context.meta else {
            return None;
        };
        let Some(Value::Object(state)) = meta.get(META) else {
            return None;
        };
        let Some(Value::Number(id)) = state.get("id") else {
            return None;
        };
        let flag = |name: &str| matches!(state.get(name), Some(Value::Bool(true)));
        Some(ParseState {
            id: *id as u64,
            strict: flag("strict"),
            empty: flag("empty"),
        })
    }
}

/// What changes during a parse, under the parse's id in [`RUNNING`].
struct Running {
    id: u64,
    /// The YAML documents the stream has opened so far.
    docs: usize,
    /// The first token the root rule opened on: `Some(None)` when it
    /// opened on none, TypeScript's `NOTOKEN`, and `None` until the
    /// root's open pass has been seen.
    root: Option<Option<Token>>,
    /// The first error a check raised.
    error: Option<OpenApiError>,
}

impl Running {
    /// Record the parse's error, the first one only, and have the guard
    /// stop the parse.
    fn fail(&mut self, error: OpenApiError) {
        if self.error.is_none() {
            self.error = Some(error);
            FAILED.with(|failed| failed.set(true));
        }
    }
}

thread_local! {
    /// Every parse `parse` has started on this thread and not finished,
    /// innermost last.
    static RUNNING: RefCell<Vec<Running>> = const { RefCell::new(Vec::new()) };

    /// Whether any of them holds an error, so that the guard, which runs
    /// at every step, costs one read of this while none does.
    static FAILED: Cell<bool> = const { Cell::new(false) };
}

/// The next parse id. Unique per process, which is more than an entry
/// keyed per thread needs.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// One parse's entry in [`RUNNING`], removed when this is dropped, however
/// the parse ends.
struct Run {
    state: ParseState,
}

impl Run {
    fn start(strict: bool, empty: bool) -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        RUNNING.with(|running| {
            running.borrow_mut().push(Running {
                id,
                docs: 0,
                root: None,
                error: None,
            });
        });
        Run {
            state: ParseState { id, strict, empty },
        }
    }

    /// The error a check recorded, if one did.
    fn finish(self) -> Option<OpenApiError> {
        RUNNING.with(|running| {
            running
                .borrow_mut()
                .iter_mut()
                .find(|entry| entry.id == self.state.id)
                .and_then(|entry| entry.error.take())
        })
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        // `try_with` and `try_borrow_mut`, because a drop must not panic:
        // this can run while a panic unwinds.
        let _ = RUNNING.try_with(|running| {
            if let Ok(mut running) = running.try_borrow_mut() {
                running.retain(|entry| entry.id != self.state.id);
                let failed = running.iter().any(|entry| entry.error.is_some());
                let _ = FAILED.try_with(|flag| flag.set(failed));
            }
        });
    }
}

/// Run `check` on the state of the parse `context` belongs to, when
/// `parse` started it and no check has failed in it yet.
fn with_state(context: &Context, check: impl FnOnce(ParseState, &mut Running)) {
    let Some(state) = ParseState::of(context) else {
        return;
    };
    RUNNING.with(|running| {
        let mut running = running.borrow_mut();
        if let Some(entry) = running.iter_mut().rev().find(|entry| entry.id == state.id) {
            if entry.error.is_none() {
                check(state, entry);
            }
        }
    });
}

/// The parse guard: stop a parse in which a check has failed. Cheap
/// while no parse on this thread holds an error, which is nearly always.
fn keep_going(context: &Context) -> bool {
    if !FAILED.with(Cell::get) {
        return true;
    }
    let Some(state) = ParseState::of(context) else {
        return true;
    };
    RUNNING.with(|running| {
        !running
            .borrow()
            .iter()
            .any(|entry| entry.id == state.id && entry.error.is_some())
    })
}

// ---------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------

/// The checks, on each rule pass. They run only in a parse [`parse`]
/// started. Mirrors `check` in `ts/src/openapi.ts`; the root's first
/// token is recorded here as well, since TypeScript reads it from
/// `ctx.root()`, the root rule, which a Rust context does not hold.
fn check(rule: &Rule, context: &Context, done: &RuleDone) {
    if done.probe || done.forced {
        return;
    }
    match done.state {
        RuleState::Open => {
            // The root rule is instance 1 in every engine.
            if rule.i == 1 {
                with_state(context, |_state, running| {
                    if running.root.is_none() {
                        running.root = Some(rule.o0().cloned());
                    }
                });
            }
            // Each document of a YAML stream is a `val` the `stream` rule
            // pushes. The second one is refused where it starts.
            if rule.name == "stream" && done.alt.as_ref().is_some_and(|alt| alt.p == "val") {
                with_state(context, |_state, running| {
                    running.docs += 1;
                    if 1 < running.docs {
                        let at = placement(rule, context);
                        running.fail(raise(STREAM, &[], at, rule, context, RuleState::Open));
                    }
                });
            } else if rule.name == "pair" {
                check_pair(rule, context);
            }
        }
        RuleState::Close => {
            // The root, once the root rule has closed for the last time.
            let last = done
                .alt
                .as_ref()
                .is_none_or(|alt| alt.p.is_empty() && alt.r.is_empty() && alt.err.is_none());
            if rule.d == 0 && last {
                check_root(rule, context);
            }
        }
    }
}

/// A repeated member name, under strict. The open pass of a pair has read
/// its key and not yet set its value, so the key is already in the map
/// only when it is repeated. The map is read first, so that a pair whose
/// key is new costs no look at the parse state.
fn check_pair(rule: &Rule, context: &Context) {
    let Some(key) = rule.u.get("key") else {
        return;
    };
    let Value::String(name) = key else {
        return;
    };
    if !map_of(&rule.node.borrow()).is_some_and(|members| members.contains_key(name.as_str())) {
        return;
    }
    with_state(context, |state, running| {
        if state.strict {
            let at = placement(rule, context);
            let details = [("key", quoted(key))];
            running.fail(raise(
                DUPLICATE_KEY,
                &details,
                at,
                rule,
                context,
                RuleState::Open,
            ));
        }
    });
}

/// The root must be a map and, under strict, name a version this package
/// reads. The value is the root rule's node as the engine returns it from
/// the parse: the node of the last rule at depth 0, which a rotation of
/// the root (`r: stream`) shares with the first.
fn check_root(rule: &Rule, context: &Context) {
    with_state(context, |state, running| {
        let value = rule.node.borrow();
        let at = match &running.root {
            Some(Some(token)) if token.tin != TIN_ZZ => Some(token),
            Some(None) => None,
            _ => placement(rule, context),
        };
        if !is_map(&value) {
            let kind = if state.empty {
                "empty"
            } else {
                kind_of(&value)
            };
            let details = [("kind", kind.to_string())];
            let error = raise(ROOT, &details, at, rule, context, RuleState::Close);
            running.fail(error);
        } else if state.strict {
            let found = version(&value);
            if found.version == UNKNOWN {
                let found = match found.field {
                    None => "no openapi or swagger member".to_string(),
                    Some(field) => format!("{field} is {}", quoted(&found.value)),
                };
                let details = [("found", found)];
                let error = raise(VERSION_CODE, &details, at, rule, context, RuleState::Close);
                running.fail(error);
            }
        }
    });
}

/// The token to place an error at: the one the rule opened on, else the
/// one in hand when that is the end of the text. `None` stands for
/// TypeScript's `NOTOKEN`, which a rule that opened on no token reports,
/// and which places the error at 1:1.
fn placement<'a>(rule: &'a Rule, context: &'a Context) -> Option<&'a Token> {
    match rule.o0() {
        Some(token) if token.tin == TIN_ZZ => context.t0().filter(|token| !token.is_no_token()),
        other => other,
    }
}

/// An error as the engine builds one for a token and a rule: the code,
/// the message and hint from the instance's catalogue with `details`
/// filled in, the token's position, the rule and its stack, and the
/// plugins.
fn raise(
    code: &str,
    details: &[(&str, String)],
    at: Option<&Token>,
    rule: &Rule,
    context: &Context,
    state: RuleState,
) -> OpenApiError {
    let src = at.map_or("", |token| token.src.as_str());
    let mut error = OpenApiError::new(code, src, context.source.as_str(), 0, 1, 1);

    // What the rule could have read here, as the engine lists it.
    let alts = match state {
        RuleState::Open => &rule.spec.open,
        RuleState::Close => &rule.spec.close,
    };
    let expected = alts
        .iter()
        .filter_map(|alt| alt.s.first())
        .flatten()
        .map(|tin| context.options.token_name(*tin))
        .collect();
    let stack = context
        .rule_stack
        .iter()
        .map(|ancestor| ancestor.name.to_string())
        .chain(std::iter::once(rule.name.to_string()))
        .collect();
    let rule_state = match state {
        RuleState::Open => "o",
        RuleState::Close => "c",
    };
    error.attach_context(rule.name.as_str(), rule_state, stack, at, expected);
    if at.is_none() {
        error.token = ErrorToken {
            name: String::new(),
            src: String::new(),
        };
    }

    let position = [
        ("code", code.to_string()),
        ("src", src.to_string()),
        ("pos", error.pos.to_string()),
        ("row", error.row.to_string()),
        ("col", error.col.to_string()),
        ("rulename", rule.name.to_string()),
    ];
    let vars: Vec<(&str, &str)> = position
        .iter()
        .chain(details)
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let message = template(&context.options.error, &ERRORS, code);
    let hint = template(&context.options.hint, &HINTS, code);
    error.detail = render(message, &vars);
    error.hint = render(hint, &vars).trim().to_string();
    error.plugins.clone_from(&context.instance.plugins);
    error.tag.clone_from(&context.options.errmsg.name);
    error
}

/// A code's template from the instance's catalogue, which may override
/// the plugin's own, else the plugin's own.
fn template<'a>(
    catalogue: &'a std::collections::HashMap<String, String>,
    own: &'a [(&str, &str)],
    code: &str,
) -> &'a str {
    catalogue
        .get(code)
        .map(String::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            own.iter()
                .find(|(name, _)| *name == code)
                .map(|(_, text)| *text)
        })
        .unwrap_or("")
}

/// Fill each `{name}` in `template` from `vars`, in one pass, as the
/// engine does: a value is not read for placeholders again, and a name
/// with no value is left as written.
fn render(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let name = &after[..close];
                match vars.iter().rev().find(|(var, _)| *var == name) {
                    Some((_, value)) => out.push_str(value),
                    None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Document content in a message: JSON-quoted, as `JSON.stringify`
/// writes it, so a control character or a quote cannot reshape the
/// message, and cut to 57 UTF-16 units and `...` when longer than 60, as
/// JavaScript counts a string's length.
///
/// A character outside the Basic Multilingual Plane that straddles the
/// cut is dropped whole, where JavaScript keeps its first half: a Rust
/// string cannot hold half a surrogate pair.
fn quoted(value: &Value) -> String {
    let mut text = String::new();
    if !write_json(value, &mut text) {
        // `JSON.stringify(undefined)` is undefined, and `String` of it
        // reads so.
        text = "undefined".to_string();
    }
    if text.encode_utf16().count() <= 60 {
        return text;
    }
    let mut cut = String::new();
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if 57 < units {
            break;
        }
        cut.push(c);
    }
    cut.push_str("...");
    cut
}

/// Write `value` as `JSON.stringify` does: members in order, a member
/// whose value is undefined left out and an undefined list item written
/// as `null`, a number as JavaScript prints it and one JSON cannot carry
/// as `null`. Returns false, writing nothing, for an undefined value.
fn write_json(value: &Value, out: &mut String) -> bool {
    match value {
        Value::Undefined => return false,
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&js_number(*number)),
        Value::String(text) => write_string(text, out),
        Value::Text(text) => write_string(&text.string, out),
        Value::Array(items) => write_list(items, out),
        Value::ListRef(list) => write_list(&list.value, out),
        Value::Object(members) => write_map(members, out),
        Value::MapRef(map) => write_map(&map.value, out),
    }
    true
}

fn write_string(text: &str, out: &mut String) {
    // serde_json escapes a string as `JSON.stringify` does: the quote,
    // the backslash and the control characters, the short forms where
    // JSON has them and `\u00xx` otherwise.
    if let Ok(quoted) = serde_json::to_string(text) {
        out.push_str(&quoted);
    }
}

fn write_list(items: &[Value], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if 0 < index {
            out.push(',');
        }
        if !write_json(item, out) {
            out.push_str("null");
        }
    }
    out.push(']');
}

fn write_map(members: &IndexMap<String, Value>, out: &mut String) {
    out.push('{');
    let mut first = true;
    for (name, member) in members {
        if member.is_undefined() {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        write_string(name, out);
        out.push(':');
        write_json(member, out);
    }
    out.push('}');
}

/// A number as JavaScript's `Number.prototype.toString` writes it (ECMA-262
/// `Number::toString`): the shortest digits that read back to the same
/// double, positional between 1e-7 and 1e21 and exponential outside,
/// `-0` as `0`, and, as `JSON.stringify` has it, `null` for a number that
/// is not finite.
fn js_number(number: f64) -> String {
    if !number.is_finite() {
        return "null".to_string();
    }
    if number == 0.0 {
        return "0".to_string();
    }
    // Rust's `{:e}` is the shortest round-trip form, `d.ddde<exp>`.
    let scientific = format!("{:e}", number.abs());
    let Some((mantissa, exponent)) = scientific.split_once('e') else {
        return number.to_string();
    };
    let Ok(exponent) = exponent.parse::<i32>() else {
        return number.to_string();
    };
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let count = digits.len() as i32;
    // Where the decimal point falls, counted from the left of the digits.
    let point = exponent + 1;
    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let power = point - 1;
        let sign = if power < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", power.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", power.abs())
        }
    };
    if number < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// The members of a map, whichever form the engine built it in.
fn map_of(value: &Value) -> Option<&IndexMap<String, Value>> {
    match value {
        Value::Object(members) => Some(members),
        Value::MapRef(map) => Some(&map.value),
        _ => None,
    }
}

fn is_map(value: &Value) -> bool {
    map_of(value).is_some()
}

/// What the root is, for `openapi_root`, in TypeScript's words.
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Undefined => "empty",
        Value::Null => "null",
        Value::Array(_) | Value::ListRef(_) => "a list",
        Value::String(_) | Value::Text(_) => "a string",
        Value::Number(_) => "a number",
        Value::Bool(_) => "a Boolean",
        Value::Object(_) | Value::MapRef(_) => "a map",
    }
}

// ---------------------------------------------------------------------
// version
// ---------------------------------------------------------------------

const UNKNOWN: &str = "unknown";

/// The OpenAPI or Swagger version a tree's root names, from [`version`].
#[derive(Debug, Clone, PartialEq)]
pub struct VersionInfo {
    /// The version, to its minor: `"2.0"` for Swagger, `"3.0"`, `"3.1"`
    /// or `"3.2"` for OpenAPI, and `"unknown"` for anything else.
    pub version: &'static str,
    /// The member the version came from, `openapi` taking precedence, or
    /// `None` when the root has neither.
    pub field: Option<&'static str>,
    /// That member's value, as written, and `Value::Undefined` when there
    /// is no such member.
    pub value: Value,
}

/// Read the version from a tree's root, leniently: a string or a number,
/// as YAML may have read an unquoted `3.1` or `2.0`. Mirrors `version` in
/// `ts/src/openapi.ts`.
///
/// `openapi` is a version string that matches
/// `^3\.([0-2])(?:\.\d+)?(?:[-+][0-9A-Za-z.-]*)?$`, or the number 3, 3.1
/// or 3.2; `swagger` a string that matches `^2\.0(?:\.\d+)?$`, or the
/// number 2. When the root has `openapi`, `swagger` is not read.
///
/// ```
/// use tabnas_openapi::{parse, version, ParseOptions};
///
/// let doc = parse("openapi: 3.1.1-rc0", &ParseOptions::default())?;
/// assert_eq!(version(&doc).version, "3.1");
///
/// let doc = parse("swagger: 2.0", &ParseOptions::default())?;
/// let found = version(&doc);
/// assert_eq!((found.version, found.field), ("2.0", Some("swagger")));
///
/// let doc = parse("info: {}", &ParseOptions::default())?;
/// assert_eq!((version(&doc).version, version(&doc).field), ("unknown", None));
/// # Ok::<(), tabnas_openapi::OpenApiError>(())
/// ```
#[must_use]
pub fn version(tree: &Value) -> VersionInfo {
    let unknown = VersionInfo {
        version: UNKNOWN,
        field: None,
        value: Value::Undefined,
    };
    let Some(members) = map_of(tree) else {
        return unknown;
    };
    if let Some(value) = members.get("openapi") {
        let minor = match value {
            Value::String(text) => openapi_minor(text),
            Value::Number(number) if *number == 3.0 => Some('0'),
            Value::Number(number) if *number == 3.1 => Some('1'),
            Value::Number(number) if *number == 3.2 => Some('2'),
            _ => None,
        };
        return VersionInfo {
            version: match minor {
                Some('0') => "3.0",
                Some('1') => "3.1",
                Some('2') => "3.2",
                _ => UNKNOWN,
            },
            field: Some("openapi"),
            value: value.clone(),
        };
    }
    if let Some(value) = members.get("swagger") {
        let known = match value {
            Value::String(text) => swagger_known(text),
            Value::Number(number) => *number == 2.0,
            _ => false,
        };
        return VersionInfo {
            version: if known { "2.0" } else { UNKNOWN },
            field: Some("swagger"),
            value: value.clone(),
        };
    }
    unknown
}

/// The minor version of an `openapi` string, by TypeScript's
/// `^3\.([0-2])(?:\.\d+)?(?:[-+][0-9A-Za-z.-]*)?$`, written out because
/// a regular expression crate would be a dependency of its own.
fn openapi_minor(text: &str) -> Option<char> {
    let rest = text.strip_prefix("3.")?;
    let mut chars = rest.chars();
    let minor = chars.next().filter(|c| ('0'..='2').contains(c))?;
    let mut rest = chars.as_str();
    // `(?:\.\d+)?`, where `\d` is an ASCII digit.
    if let Some(after) = rest.strip_prefix('.') {
        let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            return None;
        }
        rest = &after[digits..];
    }
    // `(?:[-+][0-9A-Za-z.-]*)?` and the end.
    if let Some(after) = rest.strip_prefix(['-', '+']) {
        let suffix = after
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        return suffix.then_some(minor);
    }
    rest.is_empty().then_some(minor)
}

/// Whether a `swagger` string is a version this package reads, by
/// TypeScript's `^2\.0(?:\.\d+)?$`.
fn swagger_known(text: &str) -> bool {
    match text.strip_prefix("2.0") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

// ---------------------------------------------------------------------
// The fast path
// ---------------------------------------------------------------------

/// The fast path: `serde_json` reads the text into the engine's tree,
/// maps in document order. `None` when the grammar must decide instead:
/// `serde_json` refused the text, or its root is not a map.
///
/// `serde_json` checks the syntax and decodes the strings, and the tree
/// is built here rather than through `serde_json::Value`, for two
/// reasons. A repeated name keeps its last value at the place of its
/// first, as `JSON.parse` and the grammar keep it, which is what an
/// insertion into an `IndexMap` does. And every number is read from its
/// own text with `str::parse::<f64>`, as the grammar's lexer reads it:
/// without its `float_roundtrip` feature, which only this crate's tests
/// switch on, `serde_json` can land a long decimal one unit in the last
/// place away from the correctly rounded double.
///
/// A number out of the double's range (`1e400`) is refused by
/// `serde_json`, so it falls to the grammar, which reads it as an
/// infinity, as `JSON.parse` does. So does a lone surrogate escape, which
/// a Rust string cannot hold; the grammar reads it as U+FFFD.
fn fast_parse(text: &str) -> Option<Value> {
    let mut numbers = Numbers {
        text: text.as_bytes(),
        at: 0,
    };
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = Tree {
        numbers: &mut numbers,
    }
    .deserialize(&mut deserializer)
    .ok()?;
    deserializer.end().ok()?;
    is_map(&value).then_some(value)
}

/// The number tokens of a JSON text, in order. `serde_json` reports each
/// number as it reads it, in the order of the text, and a key is always a
/// string, so the n-th number it reports is the n-th number token here.
struct Numbers<'t> {
    text: &'t [u8],
    at: usize,
}

impl Numbers<'_> {
    /// The next number token's value, read as the grammar reads one.
    fn next_number(&mut self) -> Option<f64> {
        let text = self.text;
        let mut at = self.at;
        while at < text.len() {
            match text[at] {
                b'"' => {
                    // Skip the string, its escapes with it.
                    at += 1;
                    while at < text.len() {
                        match text[at] {
                            b'\\' => at += 2,
                            b'"' => {
                                at += 1;
                                break;
                            }
                            _ => at += 1,
                        }
                    }
                }
                b'-' | b'0'..=b'9' => {
                    let start = at;
                    while at < text.len()
                        && matches!(text[at], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                    {
                        at += 1;
                    }
                    self.at = at;
                    return std::str::from_utf8(&text[start..at]).ok()?.parse().ok();
                }
                _ => at += 1,
            }
        }
        self.at = at;
        None
    }
}

/// Builds the engine's tree from `serde_json`'s reading of the text.
struct Tree<'n, 't> {
    numbers: &'n mut Numbers<'t>,
}

impl Tree<'_, '_> {
    fn number<E: de::Error>(self) -> Result<Value, E> {
        self.numbers
            .next_number()
            .map(Value::Number)
            .ok_or_else(|| E::custom("a number the text does not hold"))
    }
}

impl<'de> DeserializeSeed<'de> for Tree<'_, '_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Tree<'_, '_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, _value: i64) -> Result<Value, E> {
        self.number()
    }

    fn visit_u64<E: de::Error>(self, _value: u64) -> Result<Value, E> {
        self.number()
    }

    fn visit_f64<E: de::Error>(self, _value: f64) -> Result<Value, E> {
        self.number()
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_string()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(Tree {
            numbers: &mut *self.numbers,
        })? {
            items.push(item);
        }
        Ok(Value::array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut members = IndexMap::new();
        while let Some(name) = map.next_key::<String>()? {
            let value = map.next_value_seed(Tree {
                numbers: &mut *self.numbers,
            })?;
            // A repeated name keeps its last value, at the place of its
            // first.
            members.insert(name, value);
        }
        Ok(Value::object(members))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fast_path_builds_maps_in_order_and_reads_numbers_from_their_text() {
        let text = r#" {"a":0.1,"b":"x-1 \"2\" \\","c":[1e2,-0,12345678901234567890],"a":3} "#;
        let value = fast_parse(text).expect("JSON text whose root is a map");
        let members = map_of(&value).expect("a map");
        let names: Vec<&String> = members.keys().collect();
        assert_eq!(names, ["a", "b", "c"]);
        assert_eq!(members["a"], Value::Number(3.0));
        assert_eq!(members["b"], Value::String("x-1 \"2\" \\".into()));
        let Value::Array(items) = &members["c"] else {
            panic!("c is a list");
        };
        assert_eq!(items[0], Value::Number(100.0));
        assert!(matches!(items[1], Value::Number(zero) if zero == 0.0 && zero.is_sign_negative()));
        assert_eq!(items[2], Value::Number(12345678901234567890.0));
    }

    #[test]
    fn the_fast_path_declines_what_the_grammar_must_decide() {
        for text in [
            "",
            "[1,2]",
            "\"x\"",
            "null",
            r#"{"a":1e400}"#,
            r#"{"a":"\ud800"}"#,
            "\u{FEFF}{}",
            r#"{"a":1,}"#,
            "{} {}",
            r#"{"a":01}"#,
            r#"{"a":.5}"#,
            "{\"a\":\"x\ty\"}",
            "{a:1}",
        ] {
            assert!(fast_parse(text).is_none(), "{text:?}");
        }
    }

    #[test]
    fn auto_takes_the_fast_path_for_text_that_opens_with_a_brace() {
        assert!(Fast::Auto.takes("{}"));
        assert!(Fast::Auto.takes(" \t\r\n{}"));
        assert!(!Fast::Auto.takes("\u{FEFF}{}"));
        assert!(!Fast::Auto.takes("\u{A0}{}"));
        assert!(!Fast::Auto.takes("[{}]"));
        assert!(!Fast::Auto.takes(""));
        assert!(Fast::On.takes("[{}]"));
        assert!(!Fast::Off.takes("{}"));
    }

    #[test]
    fn a_number_is_written_as_javascript_writes_it() {
        for (number, want) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-2.5, "-2.5"),
            (3.1, "3.1"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-6, "0.000001"),
            (0.000123, "0.000123"),
            (1e-7, "1e-7"),
            (-1e-7, "-1e-7"),
            (1.25e-7, "1.25e-7"),
            (123.456, "123.456"),
            (0.1 + 0.2, "0.30000000000000004"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::INFINITY, "null"),
            (f64::NAN, "null"),
        ] {
            assert_eq!(js_number(number), want, "{number:e}");
        }
    }

    #[test]
    fn a_template_is_filled_once_and_unknown_names_stay() {
        let vars = [("kind", "{kind} a list"), ("src", "x")];
        assert_eq!(
            render("is {kind} at {src}, {missing} {", &vars),
            "is {kind} a list at x, {missing} {"
        );
        assert_eq!(render("", &vars), "");
        assert_eq!(render("{}", &vars), "{}");
    }

    #[test]
    fn a_value_is_quoted_as_json_stringify_quotes_it() {
        let mut members = IndexMap::new();
        members.insert("u".to_string(), Value::Undefined);
        members.insert("n".to_string(), Value::Null);
        members.insert(
            "l".to_string(),
            Value::array(vec![
                Value::Undefined,
                Value::Bool(true),
                Value::Number(-0.0),
            ]),
        );
        members.insert("s".to_string(), Value::String("\u{1}\u{7F}\u{2028}".into()));
        assert_eq!(
            quoted(&Value::object(members)),
            "{\"n\":null,\"l\":[null,true,0],\"s\":\"\\u0001\u{7F}\u{2028}\"}"
        );
        assert_eq!(quoted(&Value::Undefined), "undefined");
        // Sixty units quoted stay whole; sixty-one are cut to 57 and `...`.
        let whole = format!("\"{}\"", "k".repeat(58));
        assert_eq!(quoted(&Value::String("k".repeat(58))), whole);
        let cut = format!("\"{}...", "k".repeat(56));
        assert_eq!(quoted(&Value::String("k".repeat(59))), cut);
    }
}
