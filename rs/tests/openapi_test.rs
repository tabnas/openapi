// The crate surface, the Rust half of ts/test/openapi.test.ts and
// go/openapi_test.go.

mod common;

use std::fs;
use std::sync::{Arc, Mutex};

use tabnas::{Tabnas, Value};
use tabnas_openapi::{
    make, make_with, openapi, parse, plugin, version, Fast, MakeOptions, OpenApiError,
    OpenApiOptions, ParseOptions,
};

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

// ---------------------------------------------------------------------
// Raw mode: `parse`, its checks and its fast path, the Rust half of the
// "raw mode" block of ts/test/openapi.test.ts.
// ---------------------------------------------------------------------

/// The default options with the fast path set.
fn fast(fast: Fast) -> ParseOptions<'static> {
    ParseOptions {
        fast,
        ..ParseOptions::default()
    }
}

fn strict() -> ParseOptions<'static> {
    ParseOptions {
        strict: true,
        ..ParseOptions::default()
    }
}

/// The error a parse returns, failing the test when it returns a tree.
fn failure(result: Result<Value, OpenApiError>) -> OpenApiError {
    result.expect_err("expected an error")
}

/// A parse as JSON with whole numbers as integers, or the error's code.
fn read(src: &str, options: &ParseOptions<'_>) -> Result<serde_json::Value, String> {
    parse(src, options)
        .map(|value| integral_numbers(value.to_json()))
        .map_err(|error| error.code)
}

/// The members of a map, whichever form the engine built it in.
fn members(value: &Value) -> &indexmap::IndexMap<String, Value> {
    match value {
        Value::Object(members) => members,
        Value::MapRef(map) => &map.value,
        other => panic!("not a map: {other:?}"),
    }
}

/// The member `name` of a map.
fn member<'a>(value: &'a Value, name: &str) -> &'a Value {
    members(value)
        .get(name)
        .unwrap_or_else(|| panic!("no member {name:?} in {value}"))
}

/// Every map in a tree, with its path, its form and its member names in
/// order.
fn maps(node: &Value, path: &str, out: &mut Vec<(String, &'static str, Vec<String>)>) {
    match node {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                maps(item, &format!("{path}/{index}"), out);
            }
        }
        Value::Object(_) | Value::MapRef(_) => {
            let form = if matches!(node, Value::Object(_)) {
                "Object"
            } else {
                "MapRef"
            };
            let entries = members(node);
            out.push((path.to_string(), form, entries.keys().cloned().collect()));
            for (name, member) in entries {
                maps(member, &format!("{path}/{name}"), out);
            }
        }
        _ => {}
    }
}

#[test]
fn parse_reads_the_petstore_in_both_forms_to_one_document() {
    for name in ["petstore.yaml", "petstore.json"] {
        for path in [Fast::On, Fast::Off, Fast::Auto] {
            assert_eq!(
                read(&petstore(name), &fast(path)),
                Ok(want()),
                "{name} fast {path:?}"
            );
        }
    }
    assert_eq!(read(&petstore("petstore.json"), &strict()), Ok(want()));
}

/// TypeScript holds both paths to null-prototype maps; a Rust map has no
/// prototype, so what is held here is that both paths build the same
/// form of map, with the members in one order.
#[test]
fn both_paths_build_maps_alike_members_in_one_order() {
    let text = petstore("petstore.json");
    let mut on = Vec::new();
    let mut off = Vec::new();
    maps(&parse(&text, &fast(Fast::On)).unwrap(), "", &mut on);
    maps(&parse(&text, &fast(Fast::Off)).unwrap(), "", &mut off);
    assert!(10 < on.len(), "the petstore has maps: {}", on.len());
    assert_eq!(on, off);
    // Document order, `200` before `default`, on both paths. The path
    // joins names with `/`, so the `/pets` member makes the `//`.
    let responses = on
        .iter()
        .find(|(path, _, _)| path == "/paths//pets/get/responses")
        .expect("the /pets get responses");
    assert_eq!(responses.2, ["200", "default"]);
}

#[test]
fn a_member_named_proto_is_data_on_both_paths() {
    for path in [Fast::On, Fast::Off] {
        let tree = parse(
            r#"{"__proto__":{"polluted":1},"a":[{"__proto__":2}]}"#,
            &fast(path),
        )
        .unwrap();
        let names: Vec<&String> = members(&tree).keys().collect();
        assert_eq!(names, ["__proto__", "a"], "{path:?}");
        assert_eq!(
            integral_numbers(member(&tree, "__proto__").to_json()),
            serde_json::json!({ "polluted": 1 })
        );
        let Value::Array(items) = member(&tree, "a") else {
            panic!("a is a list");
        };
        assert_eq!(member(&items[0], "__proto__"), &Value::Number(2.0));
    }
}

/// Measured, not assumed: what each path gives where JSON and the double
/// part ways. `serde_json` refuses `1e400` (out of the double's range)
/// and a lone surrogate escape, so the fast path declines both and the
/// grammar reads them, and the two paths agree. With TypeScript they
/// agree on the infinities, -0 and the YAML specials; a lone surrogate is
/// the one place they differ, since a Rust string cannot hold one.
#[test]
fn numbers_json_cannot_carry_and_lone_surrogates_agree_across_paths() {
    for path in [Fast::On, Fast::Off] {
        let a = |src: &str| member(&parse(src, &fast(path)).unwrap(), "a").clone();
        assert_eq!(
            a(r#"{"a":1e400}"#),
            Value::Number(f64::INFINITY),
            "{path:?}"
        );
        assert_eq!(
            a(r#"{"a":-1e400}"#),
            Value::Number(f64::NEG_INFINITY),
            "{path:?}"
        );
        // TypeScript keeps the lone surrogate, '\ud800', on both paths;
        // Rust reads it as U+FFFD, the replacement character.
        assert_eq!(
            a(r#"{"a":"\ud800"}"#),
            Value::String("\u{FFFD}".into()),
            "{path:?}"
        );
        let Value::Number(zero) = a(r#"{"a":-0}"#) else {
            panic!("-0 is a number");
        };
        assert!(zero == 0.0 && zero.is_sign_negative(), "{path:?}: {zero}");
    }
    let a = |src: &str| member(&parse(src, &ParseOptions::default()).unwrap(), "a").clone();
    assert_eq!(a("a: .inf"), Value::Number(f64::INFINITY));
    assert_eq!(a("a: -.inf"), Value::Number(f64::NEG_INFINITY));
    assert!(matches!(a("a: .nan"), Value::Number(n) if n.is_nan()));
}

/// The fast path reads every number from its own text, as the grammar
/// does, so the two give the same double, bit for bit, however long the
/// number.
#[test]
fn both_paths_read_a_number_to_the_same_double() {
    for number in [
        "0.1",
        "0.30000000000000004",
        "0.12345678901234567",
        "3.141592653589793238462643383279",
        "9007199254740993",
        "123456789012345678901234567890",
        "2.2250738585072011e-308",
        "4.9e-324",
        "1.7976931348623157e308",
        "1e-400",
        "-1.5E-3",
        "1e+2",
    ] {
        let src = format!(r#"{{"a":{number}}}"#);
        let bits = |path| match member(&parse(&src, &fast(path)).unwrap(), "a") {
            Value::Number(n) => n.to_bits(),
            other => panic!("{number}: {other:?}"),
        };
        assert_eq!(bits(Fast::On), bits(Fast::Off), "{number}");
        assert_eq!(
            bits(Fast::On),
            number.parse::<f64>().unwrap().to_bits(),
            "{number}"
        );
    }
}

/// A repeated name keeps its last value, whole, at the place of its
/// first, on both paths and through the engine's own parse.
#[test]
fn a_repeated_name_keeps_its_last_value_at_its_first_place() {
    let want = serde_json::json!({ "a": { "y": 2 }, "b": 1 });
    for path in [Fast::On, Fast::Off] {
        let tree = parse(r#"{"a":{"x":1},"b":1,"a":{"y":2}}"#, &fast(path)).unwrap();
        let names: Vec<&String> = members(&tree).keys().collect();
        assert_eq!(names, ["a", "b"], "{path:?}");
        assert_eq!(integral_numbers(tree.to_json()), want, "{path:?}");
    }
    assert_eq!(
        outcome(&make(), "a:\n  x: 1\nb: 1\na:\n  y: 2"),
        Ok(want.clone())
    );
}

#[test]
fn the_errors_carry_the_position_of_what_they_refuse() {
    let stream = failure(parse(
        "openapi: 3.1.0\n---\nopenapi: 3.0.0",
        &ParseOptions::default(),
    ));
    // At the first line of the second document's content, where the yaml
    // lexer places the `---` that opens it, as in TypeScript.
    assert_eq!(
        (
            stream.code.as_str(),
            stream.row,
            stream.col,
            stream.pos,
            stream.len
        ),
        ("openapi_stream", 3, 1, 19, 3)
    );
    assert_eq!(stream.token.name, "#DS");
    assert_eq!(
        stream.detail,
        "the text holds more than one YAML document, where a description is one"
    );
    assert_eq!(
        stream.hint,
        "Split the stream at each --- line and parse each document on its own."
    );

    let root = failure(parse("- a\n- b", &ParseOptions::default()));
    assert_eq!(
        (root.code.as_str(), root.row, root.col),
        ("openapi_root", 1, 1)
    );
    assert_eq!(
        root.detail,
        "the document is a list at its root, where an OpenAPI description is a map"
    );
    assert_eq!(
        root.hint,
        "Put the members of the description, such as openapi, info and paths, \
         at the top level of the document."
    );

    let empty = failure(parse("", &ParseOptions::default()));
    assert_eq!(
        (empty.code.as_str(), empty.row, empty.col),
        ("openapi_root", 1, 1)
    );
    assert!(empty.detail.contains("is empty at its root"), "{empty}");

    let dup = failure(parse(
        "{\"openapi\":\"3.1.0\",\n  \"a\":1,\n  \"a\":2}",
        &strict(),
    ));
    assert_eq!(
        (dup.code.as_str(), dup.row, dup.col, dup.pos, dup.len),
        ("openapi_duplicate_key", 3, 3, 31, 3)
    );
    assert_eq!(
        dup.detail,
        r#"the member name "a" appears twice in one map"#
    );
    assert_eq!(
        dup.hint,
        "Remove or rename one of the two members. JSON readers disagree on \
         which of them to keep."
    );

    let ver = failure(parse(r#"{"openapi":"4.0.0"}"#, &strict()));
    assert_eq!(ver.code, "openapi_version");
    assert_eq!(
        ver.detail,
        r#"the root names no OpenAPI or Swagger version this package reads (openapi is "4.0.0")"#
    );
    assert!(!ver.hint.is_empty());

    let none = failure(parse(r#"{"info":{}}"#, &strict()));
    assert!(
        none.detail.ends_with("(no openapi or swagger member)"),
        "{none}"
    );
    // A value of any shape is written as JSON.stringify writes it.
    let odd = failure(parse(
        r#"{"openapi":{"a":[1,"x\ny",null,1e21,0.000001,1e-7,2.5]}}"#,
        &strict(),
    ));
    assert!(
        odd.detail
            .ends_with(r#"(openapi is {"a":[1,"x\ny",null,1e+21,0.000001,1e-7,2.5]})"#),
        "{odd}"
    );
}

#[test]
fn a_member_name_in_a_message_is_quoted_and_cut_short() {
    let odd = failure(parse(
        r#"{"openapi":"3.1.0","a\"\nb":1,"a\"\nb":2}"#,
        &strict(),
    ));
    assert!(odd.detail.contains(r#""a\"\nb""#), "{}", odd.detail);

    let long = "k".repeat(200);
    let cut = failure(parse(
        &format!(r#"{{"openapi":"3.1.0","{long}":1,"{long}":2}}"#),
        &strict(),
    ));
    assert!(!cut.detail.contains(&long));
    // The quote and 56 of the name's characters: 57, then the ellipsis.
    assert_eq!(
        cut.detail,
        format!(
            r#"the member name "{}... appears twice in one map"#,
            "k".repeat(56)
        )
    );

    // A character outside the Basic Multilingual Plane that straddles
    // the cut. JavaScript cuts between its two UTF-16 halves and keeps
    // the first, a lone surrogate; a Rust string cannot hold one, so the
    // character goes whole and the text before the ellipsis is one unit
    // shorter than TypeScript's.
    let astral = format!("{}\u{1F600}{}", "k".repeat(55), "z".repeat(10));
    let cut = failure(parse(
        &format!(r#"{{"openapi":"3.1.0","{astral}":1,"{astral}":2}}"#),
        &strict(),
    ));
    assert_eq!(
        cut.detail,
        format!(
            r#"the member name "{}... appears twice in one map"#,
            "k".repeat(55)
        )
    );
}

#[test]
fn the_engine_parse_raises_nothing_of_the_plugin() {
    let parser = make();
    assert_eq!(
        outcome(&parser, "a: 1\n---\nb: 2"),
        Ok(serde_json::json!([{ "a": 1 }, { "b": 2 }]))
    );
    assert_eq!(outcome(&parser, "- a"), Ok(serde_json::json!(["a"])));
    assert_eq!(parser.parse("").unwrap(), Value::Undefined);
    let strict = make_with(&MakeOptions { strict: true });
    assert_eq!(
        outcome(&strict, r#"{"a":1,"a":2}"#),
        Ok(serde_json::json!({ "a": 2 }))
    );
    assert_eq!(
        outcome(&strict, r#"{"openapi":"4.0.0"}"#),
        Ok(serde_json::json!({ "openapi": "4.0.0" }))
    );
}

#[test]
fn parse_refuses_an_instance_without_the_plugin() {
    let bare = tabnas_yaml::make();
    let error = failure(parse(
        "{}",
        &ParseOptions {
            instance: Some(&bare),
            ..ParseOptions::default()
        },
    ));
    assert_eq!(error.code, "internal");
    assert!(error.detail.contains("no OpenApi plugin"), "{error}");
}

#[test]
fn a_given_instance_is_used() {
    let parser = make();
    let options = ParseOptions {
        instance: Some(&parser),
        fast: Fast::Off,
        ..ParseOptions::default()
    };
    assert_eq!(read("a: 1", &options), Ok(serde_json::json!({ "a": 1 })));

    // Its catalogue too: an instance that rewords a message has the
    // message it set.
    let mut reworded = make();
    reworded
        .set_options(|options| {
            options
                .error
                .insert("openapi_root".into(), "root is {kind}".into());
        })
        .unwrap();
    let error = failure(parse(
        "- a",
        &ParseOptions {
            instance: Some(&reworded),
            ..ParseOptions::default()
        },
    ));
    assert_eq!(error.detail, "root is a list");

    // And an instance the plugin was installed on by the installer
    // function rather than through `plugin()`.
    let mut by_hand = tabnas_yaml::make();
    openapi(&mut by_hand, &OpenApiOptions::default()).unwrap();
    let options = ParseOptions {
        instance: Some(&by_hand),
        ..ParseOptions::default()
    };
    assert_eq!(
        failure(parse("a: 1\n---\nb: 2", &options)).code,
        "openapi_stream"
    );
}

/// The options read from a fixture row's `opts` cell.
#[test]
fn parse_options_read_from_fixture_json() {
    let read = |raw: &str| serde_json::from_str::<ParseOptions<'static>>(raw);
    let options = read(r#"{"strict":true}"#).unwrap();
    assert!(options.strict);
    assert_eq!(options.fast, Fast::Auto);
    assert!(options.instance.is_none());
    assert_eq!(read(r#"{"fast":true}"#).unwrap().fast, Fast::On);
    assert_eq!(read(r#"{"fast":false}"#).unwrap().fast, Fast::Off);
    assert_eq!(read(r#"{"fast":"auto"}"#).unwrap().fast, Fast::Auto);
    assert_eq!(read("{}").unwrap().fast, Fast::Auto);
    assert!(read(r#"{"fast":"yes"}"#).is_err());
}

/// A failed parse leaves nothing behind on its thread: the parses after
/// it, through `parse` and through the engine's own, run whole.
#[test]
fn a_refused_parse_leaves_nothing_behind() {
    for _ in 0..3 {
        assert_eq!(
            failure(parse(r#"{"openapi":"3.1.0","a":1,"a":2}"#, &strict())).code,
            "openapi_duplicate_key"
        );
        assert_eq!(read(&petstore("petstore.json"), &strict()), Ok(want()));
        assert_eq!(
            read(&petstore("petstore.yaml"), &ParseOptions::default()),
            Ok(want())
        );
        assert_eq!(outcome(&make(), &petstore("petstore.yaml")), Ok(want()));
    }
}

/// Each parse keeps its own state: a parse started inside another, from
/// a subscriber, through `parse` or through the engine's own parse, does
/// not count its documents into the outer one, nor stop it.
#[test]
fn a_parse_inside_a_parse_keeps_its_own_state() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut outer = make();
    let record = seen.clone();
    outer.subscribe_rule_done(move |rule, _context, _done| {
        if rule.name == "pair" {
            let inner = parse("a: 1\n---\nb: 2", &ParseOptions::default());
            let plain = tabnas_yaml::make().parse("a: 1\n---\nb: 2");
            record.lock().unwrap().push((
                inner.map_err(|error| error.code),
                plain
                    .map(|value| value.to_string())
                    .map_err(|error| error.code),
            ));
        }
    });
    let options = ParseOptions {
        instance: Some(&outer),
        ..ParseOptions::default()
    };
    assert_eq!(
        read("a: 1\nb: 2", &options),
        Ok(serde_json::json!({ "a": 1, "b": 2 }))
    );
    assert_eq!(
        failure(parse("a: 1\n---\nb: 2", &options)).code,
        "openapi_stream"
    );
    let seen = seen.lock().unwrap();
    assert!(!seen.is_empty());
    for (inner, plain) in seen.iter() {
        assert_eq!(inner.as_ref().unwrap_err(), "openapi_stream");
        assert_eq!(plain.as_deref(), Ok(r#"[{"a":1},{"b":2}]"#));
    }
}

/// A failed check stops the parse at the next step, as TypeScript's
/// throw stops it: nothing after the second document's start is read,
/// and nothing after a repeated name.
#[test]
fn a_failed_check_stops_the_parse() {
    let passes = |parser: &mut Tabnas| {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        parser.subscribe_rule_done(move |rule, _context, done| {
            let key = rule.u.get("key").map(Value::to_string).unwrap_or_default();
            record
                .lock()
                .unwrap()
                .push(format!("{}~{:?}{key}", rule.name, done.state));
        });
        seen
    };

    let mut loose = make();
    let seen = passes(&mut loose);
    let options = ParseOptions {
        instance: Some(&loose),
        ..ParseOptions::default()
    };
    let error = failure(parse("a: 1\n---\nb: 2\n---\nc: 3", &options));
    assert_eq!(error.code, "openapi_stream");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.last().map(String::as_str), Some("stream~Open"));
    assert!(
        !seen
            .iter()
            .any(|pass| pass.contains("\"b\"") || pass.contains("\"c\"")),
        "{seen:?}"
    );

    let mut json = make_with(&MakeOptions { strict: true });
    let seen = passes(&mut json);
    let options = ParseOptions {
        instance: Some(&json),
        strict: true,
        ..ParseOptions::default()
    };
    let error = failure(parse(r#"{"openapi":"3.1.0","a":1,"a":2,"z":3}"#, &options));
    assert_eq!(error.code, "openapi_duplicate_key");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.last().map(String::as_str), Some("pair~Open\"a\""));
    assert!(!seen.iter().any(|pass| pass.contains("\"z\"")), "{seen:?}");
}

/// The shared parsers serve every thread, and each parse's state is its
/// own thread's.
#[test]
fn parses_on_many_threads_keep_their_own_state() {
    let handles: Vec<_> = (0..8)
        .map(|index| {
            std::thread::spawn(move || {
                for _ in 0..20 {
                    if index % 2 == 0 {
                        assert_eq!(
                            failure(parse("a: 1\n---\nb: 2", &ParseOptions::default())).code,
                            "openapi_stream"
                        );
                    } else {
                        assert_eq!(
                            read("openapi: 3.1.0\npaths: {}", &ParseOptions::default()),
                            Ok(serde_json::json!({ "openapi": "3.1.0", "paths": {} }))
                        );
                    }
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("a thread passed");
    }
}

#[test]
fn version_reads_openapi_and_swagger_leniently() {
    let cases: [(&str, &str, Option<&str>); 12] = [
        ("openapi: 3.1.0", "3.1", Some("openapi")),
        ("openapi: \"3.0.3\"", "3.0", Some("openapi")),
        ("openapi: 3.2.0", "3.2", Some("openapi")),
        ("openapi: 3.1", "3.1", Some("openapi")),
        ("openapi: 3.0", "3.0", Some("openapi")),
        ("openapi: 3.1.1-rc0", "3.1", Some("openapi")),
        ("swagger: \"2.0\"", "2.0", Some("swagger")),
        ("swagger: 2.0", "2.0", Some("swagger")),
        ("openapi: 4.0.0", "unknown", Some("openapi")),
        ("swagger: \"1.2\"", "unknown", Some("swagger")),
        ("info: {}", "unknown", None),
        ("openapi: 3.1.0\nswagger: \"2.0\"", "3.1", Some("openapi")),
    ];
    for (src, want, field) in cases {
        let got = version(&parse(src, &ParseOptions::default()).unwrap());
        assert_eq!(got.version, want, "{src}");
        assert_eq!(got.field, field, "{src}");
    }
    let list = Value::array(vec![Value::String("a".into())]);
    let got = version(&list);
    assert_eq!((got.version, got.field), ("unknown", None));
    assert_eq!(got.value, Value::Undefined);
    let got = version(&parse("openapi: 3.1", &ParseOptions::default()).unwrap());
    assert_eq!(got.value, Value::Number(3.1));
}

/// The two patterns, written out by hand, against strings a regular
/// expression engine would read the same way.
#[test]
fn version_strings_match_the_typescript_patterns() {
    let openapi = |text: &str| {
        let mut root = indexmap::IndexMap::new();
        root.insert("openapi".to_string(), Value::String(text.to_string()));
        version(&Value::object(root)).version
    };
    for (text, want) in [
        ("3.0", "3.0"),
        ("3.1", "3.1"),
        ("3.2", "3.2"),
        ("3.1.0", "3.1"),
        ("3.1.10", "3.1"),
        ("3.0.3-rc.1", "3.0"),
        ("3.1.0+build.5", "3.1"),
        ("3.1-x", "3.1"),
        ("3.1+", "3.1"),
        ("3.1.0-", "3.1"),
        ("3.3.0", "unknown"),
        ("3", "unknown"),
        ("3.", "unknown"),
        ("3.1.", "unknown"),
        ("3.1.x", "unknown"),
        ("3.1.0.1", "unknown"),
        ("3.1.0+build+5", "unknown"),
        ("3.1.0_rc", "unknown"),
        (" 3.1.0", "unknown"),
        ("3.1.0 ", "unknown"),
        ("3.1.0\n", "unknown"),
        ("3.1.\u{0661}", "unknown"),
        ("v3.1.0", "unknown"),
    ] {
        assert_eq!(openapi(text), want, "{text:?}");
    }
    let swagger = |value: Value| {
        let mut root = indexmap::IndexMap::new();
        root.insert("swagger".to_string(), value);
        version(&Value::object(root)).version
    };
    for (text, want) in [
        ("2.0", "2.0"),
        ("2.0.0", "2.0"),
        ("2.0.12", "2.0"),
        ("2", "unknown"),
        ("2.0.", "unknown"),
        ("2.0-rc", "unknown"),
        ("2.1", "unknown"),
        ("2.0.0.0", "unknown"),
    ] {
        assert_eq!(swagger(Value::String(text.into())), want, "{text:?}");
    }
    assert_eq!(swagger(Value::Number(2.0)), "2.0");
    assert_eq!(swagger(Value::Number(2.5)), "unknown");
    assert_eq!(swagger(Value::Bool(true)), "unknown");
}

/// A second install must not subscribe twice, which would count every YAML
/// document twice and refuse a single document as a stream.
#[test]
fn installing_the_plugin_twice_changes_nothing() {
    let mut parser = make();
    parser
        .use_plugin(plugin(), None)
        .expect("a second install succeeds");
    let options = tabnas_openapi::ParseOptions {
        instance: Some(&parser),
        ..Default::default()
    };
    assert!(tabnas_openapi::parse("openapi: 3.1.0\npaths: {}", &options).is_ok());
    let err = tabnas_openapi::parse("a: 1\n---\nb: 2", &options).unwrap_err();
    assert_eq!(err.code, "openapi_stream");
}
