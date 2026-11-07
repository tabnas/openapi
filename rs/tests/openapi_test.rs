// The crate surface, the Rust half of ts/test/openapi.test.ts and
// go/openapi_test.go.

mod common;

use std::fs;

use tabnas::Tabnas;
use tabnas_openapi::{make, make_with, plugin, MakeOptions};

use common::{integral_numbers, repo_root};

fn petstore(name: &str) -> String {
    let path = repo_root().join("test").join("petstore").join(name);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The petstore as serde_json reads its JSON form.
fn want() -> serde_json::Value {
    let value = serde_json::from_str(&petstore("petstore.json")).expect("petstore.json is JSON");
    integral_numbers(value)
}

/// A parse as JSON with whole numbers as integers, or the error's code.
fn outcome(parser: &Tabnas, src: &str) -> Result<serde_json::Value, String> {
    parser
        .parse(src)
        .map(|value| integral_numbers(value.to_json()))
        .map_err(|error| error.code)
}

#[test]
fn petstore_yaml_and_json_agree() {
    for name in ["petstore.yaml", "petstore.json"] {
        assert_eq!(outcome(&make(), &petstore(name)), Ok(want()), "{name}");
    }
}

#[test]
fn strict_reads_json_and_refuses_yaml() {
    let strict = make_with(&MakeOptions { strict: true });
    assert_eq!(outcome(&strict, &petstore("petstore.json")), Ok(want()));
    assert_eq!(
        outcome(&strict, &petstore("petstore.yaml")),
        Err("unexpected".to_string())
    );
}

/// `make` spells out `tabnas_yaml::make`, and strict is
/// `tabnas_json::make`, so that this crate depends on jsonic and json
/// directly. These hold the copies to the originals.
#[test]
fn make_matches_tabnas_yaml_make() {
    let inputs = [
        petstore("petstore.yaml"),
        petstore("petstore.json"),
        "a: 'x'\nb: `y`\nc: \"z\"".to_string(),
        String::new(),
    ];
    for src in &inputs {
        assert_eq!(
            outcome(&make(), src),
            outcome(&tabnas_yaml::make(), src),
            "{src:?}"
        );
    }
}

#[test]
fn strict_matches_tabnas_json_make() {
    let strict = make_with(&MakeOptions { strict: true });
    for src in [
        petstore("petstore.json"),
        r#"{"a":[1,2.5,-3,1e3]}"#.to_string(),
    ] {
        assert_eq!(
            outcome(&strict, &src),
            outcome(&tabnas_json::make(), &src),
            "{src:?}"
        );
    }
}

#[test]
fn plugin_installs_by_hand() {
    let mut parser = tabnas_yaml::make();
    parser
        .use_plugin(plugin(), None)
        .expect("the plugin installs");
    assert_eq!(
        outcome(&parser, "paths:\n  /pets: {}"),
        Ok(serde_json::json!({ "paths": { "/pets": {} } }))
    );
}
