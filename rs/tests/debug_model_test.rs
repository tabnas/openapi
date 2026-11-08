// Composition test: the OpenAPI plugin layered with the tabnas-debug
// introspection plugin, the Rust half of ts/test/debug-model.test.ts.
//
// The TypeScript suite resolves @tabnas/debug dynamically and SKIPS when
// it is absent. Here tabnas-debug is a dev-dependency on the sibling
// checkout, like every other crate this port takes, so the test FAILS to
// build when the checkout is missing rather than reporting green having
// run nothing, which is the rule the rest of this suite lives by.
//
// Raw mode is the engine's own parse, so the plugin must add no grammar:
// the model of `make()` is the model of jsonic with the yaml grammar, and
// the model of the strict parser is the model of json alone.

use tabnas::Tabnas;
use tabnas_debug::{apply, model, DebugOptions};
use tabnas_openapi::{make, make_with, MakeOptions};

/// The parser with the debug plugin layered on top, quiet: introspection
/// only, no `USE:` dump and no tracing, which is what
/// `{ print: false, trace: false }` asks for in TypeScript.
fn with_debug(mut parser: Tabnas) -> Tabnas {
    apply(&mut parser, DebugOptions::quiet()).expect("the debug plugin installs");
    parser
}

/// The grammar portion of a parser's model, as JSON.
fn grammar(parser: &Tabnas) -> serde_json::Value {
    let m = model(parser);
    serde_json::json!({
        "tokens": m.tokens,
        "rules": m.rules,
        "graph": m.graph,
        "config": m.config,
        "abnf": m.abnf,
    })
}

fn plugin_names(parser: &Tabnas) -> Vec<String> {
    model(parser)
        .plugins
        .iter()
        .map(|plugin| plugin.name.clone())
        .collect()
}

#[test]
fn parses_normally_with_the_debug_plugin_installed() {
    let parser = with_debug(make());
    let value = parser
        .parse("paths:\n  /pets: { get: {} }")
        .expect("a small document parses");
    assert_eq!(value.to_string(), r#"{"paths":{"/pets":{"get":{}}}}"#);
}

#[test]
fn the_plugin_adds_no_grammar_to_jsonic_and_yaml() {
    let parser = with_debug(make());
    let names = plugin_names(&parser);
    assert!(names.iter().any(|name| name == "OpenApi"), "{names:?}");
    let ours = grammar(&parser);
    assert_eq!(ours["config"]["start"], "stream");
    assert_eq!(ours, grammar(&with_debug(tabnas_yaml::make())));
}

#[test]
fn the_plugin_adds_no_grammar_to_strict_json() {
    let parser = with_debug(make_with(&MakeOptions { strict: true }));
    let names = plugin_names(&parser);
    assert!(names.iter().any(|name| name == "OpenApi"), "{names:?}");
    let ours = grammar(&parser);
    assert_eq!(ours["config"]["start"], "val");
    let m = model(&parser);
    let mut rules: Vec<&str> = m.rules.iter().map(|rule| rule.name.as_str()).collect();
    rules.sort_unstable();
    assert_eq!(rules, ["elem", "list", "map", "pair", "val"]);
    assert_eq!(ours, grammar(&with_debug(tabnas_json::make())));
}

#[test]
fn the_grammar_portion_serialises_and_round_trips() {
    // The TypeScript suite asserts that the grammar portion of the model
    // survives `JSON.parse(JSON.stringify(..))`. The Rust model derives
    // `Serialize` only, so the round trip is serialise, parse as generic
    // JSON, and compare: a value that does not survive that (a non-finite
    // number, a map with non-string keys) fails here.
    let ours = grammar(&with_debug(make()));
    let text = serde_json::to_string(&ours).expect("the grammar portion serialises");
    let back: serde_json::Value = serde_json::from_str(&text).expect("and parses back");
    assert_eq!(back, ours);
}
