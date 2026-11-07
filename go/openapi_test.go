// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

package tabnasopenapi

// openapi_test.go — the package surface, mirroring ts/test/openapi.test.ts.

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	tabnasjson "github.com/tabnas/json/go"
	tabnas "github.com/tabnas/parser/go"
	yaml "github.com/tabnas/yaml/go"
)

func petstore(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "test", "petstore", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// want is the petstore as the standard library reads its JSON form.
func want(t *testing.T) any {
	t.Helper()
	var out any
	if err := json.Unmarshal([]byte(petstore(t, "petstore.json")), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func parse(t *testing.T, j *tabnas.Tabnas, src string) any {
	t.Helper()
	out, err := j.Parse(src)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return flatten(out)
}

func TestVersionLooksLikeSemver(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+`).MatchString(VERSION) {
		t.Errorf("VERSION %q is not a semver", VERSION)
	}
}

func TestPetstoreYamlAndJsonAgree(t *testing.T) {
	expect := want(t)
	for _, name := range []string{"petstore.yaml", "petstore.json"} {
		got := parse(t, Make(), petstore(t, name))
		if !reflect.DeepEqual(got, expect) {
			t.Errorf("%s: got %v", name, got)
		}
	}
}

func TestStrictReadsJsonAndRefusesYaml(t *testing.T) {
	got := parse(t, Make(MakeOptions{Strict: true}), petstore(t, "petstore.json"))
	if !reflect.DeepEqual(got, want(t)) {
		t.Errorf("strict petstore.json: got %v", got)
	}

	_, err := Make(MakeOptions{Strict: true}).Parse(petstore(t, "petstore.yaml"))
	var te *tabnas.TabnasError
	if !errors.As(err, &te) || "unexpected" != te.Code {
		t.Errorf("strict petstore.yaml: want error code unexpected, got %v", err)
	}
}

// Make spells out yaml.MakeJsonic, and strict spells out tabnasjson.Make,
// so that this package depends on jsonic and json directly. These hold the
// copies to the originals.
func TestMakeMatchesYamlMakeJsonic(t *testing.T) {
	inputs := []string{
		petstore(t, "petstore.yaml"),
		petstore(t, "petstore.json"),
		"a: 'x'\nb: `y`\nc: \"z\"",
		"",
	}
	for _, src := range inputs {
		got, gerr := Make().Parse(src)
		exp, eerr := yaml.MakeJsonic().Parse(src)
		if (nil == gerr) != (nil == eerr) {
			t.Errorf("%q: error %v, yaml.MakeJsonic error %v", src, gerr, eerr)
			continue
		}
		if !reflect.DeepEqual(flatten(got), flatten(exp)) {
			t.Errorf("%q: got %v, yaml.MakeJsonic gives %v", src, got, exp)
		}
	}
}

func TestStrictMatchesJsonMake(t *testing.T) {
	for _, src := range []string{petstore(t, "petstore.json"), `{"a":[1,2.5,-3,1e3]}`} {
		got := parse(t, Make(MakeOptions{Strict: true}), src)
		exp := parse(t, tabnasjson.Make(), src)
		if !reflect.DeepEqual(got, exp) {
			t.Errorf("%q: got %v, tabnasjson.Make gives %v", src, got, exp)
		}
	}
}

func TestPluginInstallsByHand(t *testing.T) {
	j := yaml.MakeJsonic()
	if err := j.UseDefaults(OpenApi, Defaults); err != nil {
		t.Fatal(err)
	}
	got := parse(t, j, "paths:\n  /pets: {}")
	exp := map[string]any{"paths": map[string]any{"/pets": map[string]any{}}}
	if !reflect.DeepEqual(got, exp) {
		t.Errorf("got %v", got)
	}
}

// ---- Raw mode: the "raw mode" block of ts/test/openapi.test.ts.

// esc writes a backslash for each ~, so that a test can spell a JSON
// escape such as ~ud800 that Go would otherwise read itself.
func esc(s string) string { return strings.ReplaceAll(s, "~", `\`) }

var strict = ParseOptions{Strict: true}

// mustParse is Parse, failing the test on an error.
func mustParse(t *testing.T, src string, opts ...ParseOptions) any {
	t.Helper()
	out, err := Parse(src, opts...)
	if err != nil {
		t.Fatalf("Parse(%q): %v", src, err)
	}
	return out
}

// failure is the *tabnas.TabnasError Parse returns, failing the test when
// it returns anything else.
func failure(t *testing.T, src string, opts ...ParseOptions) *tabnas.TabnasError {
	t.Helper()
	out, err := Parse(src, opts...)
	var te *tabnas.TabnasError
	if !errors.As(err, &te) {
		t.Fatalf("Parse(%q): want a *tabnas.TabnasError, got error %v and value %v", src, err, out)
	}
	return te
}

func expectError(t *testing.T, te *tabnas.TabnasError, code string, row, col int) {
	t.Helper()
	if code != te.Code || row != te.Row || col != te.Col {
		t.Errorf("want %s at %d:%d, got %s at %d:%d (%s)", code, row, col, te.Code, te.Row, te.Col, te.Detail)
	}
}

// member reads a member of a map node, failing the test when there is none.
func member(t *testing.T, node any, name string) any {
	t.Helper()
	m, ok := node.(*tabnas.OrderedMap)
	if !ok {
		t.Fatalf("want a *tabnas.OrderedMap, got %T", node)
	}
	v, ok := m.Get(name)
	if !ok {
		t.Fatalf("no member %q among %v", name, m.Keys)
	}
	return v
}

// mapAt is a map in a tree and its path.
type mapAt struct {
	path string
	node *tabnas.OrderedMap
}

// maps lists every map in a tree, with its path. A map of another type
// is listed with a nil node, for the caller to refuse.
func maps(node any, path string, out []mapAt) []mapAt {
	switch n := node.(type) {
	case []any:
		for i, item := range n {
			out = maps(item, fmt.Sprintf("%s/%d", path, i), out)
		}
	case *tabnas.OrderedMap:
		out = append(out, mapAt{path, n})
		for _, k := range n.Keys {
			out = maps(n.Vals[k], path+"/"+k, out)
		}
	case map[string]any, tabnas.MapRef:
		out = append(out, mapAt{path, nil})
	}
	return out
}

func TestParseReadsThePetstoreInBothForms(t *testing.T) {
	expect := want(t)
	for _, name := range []string{"petstore.yaml", "petstore.json"} {
		for _, fast := range []Fast{FastOn, FastOff, FastAuto} {
			got := flatten(mustParse(t, petstore(t, name), ParseOptions{Fast: fast}))
			if !reflect.DeepEqual(got, expect) {
				t.Errorf("%s, fast %s: got %v", name, fast, got)
			}
		}
	}
	got := flatten(mustParse(t, petstore(t, "petstore.json"), strict))
	if !reflect.DeepEqual(got, expect) {
		t.Errorf("strict petstore.json: got %v", got)
	}
}

// Both paths build *tabnas.OrderedMap, members in one order. In Go the two
// trees are one value, type for type, which the last check holds.
func TestBothPathsBuildOneTree(t *testing.T) {
	src := petstore(t, "petstore.json")
	fastTree := mustParse(t, src, ParseOptions{Fast: FastOn})
	grammarTree := mustParse(t, src, ParseOptions{Fast: FastOff})

	fast, grammar := maps(fastTree, "", nil), maps(grammarTree, "", nil)
	if len(fast) != len(grammar) || 0 == len(fast) {
		t.Fatalf("fast path %d maps, grammar %d", len(fast), len(grammar))
	}
	for i := range fast {
		if fast[i].path != grammar[i].path {
			t.Fatalf("map %d: fast path at %q, grammar at %q", i, fast[i].path, grammar[i].path)
		}
		if nil == fast[i].node || nil == grammar[i].node {
			t.Fatalf("%s: a map that is not a *tabnas.OrderedMap", fast[i].path)
		}
		if !reflect.DeepEqual(fast[i].node.Keys, grammar[i].node.Keys) {
			t.Errorf("%s: fast path %v, grammar %v", fast[i].path, fast[i].node.Keys, grammar[i].node.Keys)
		}
	}
	if !reflect.DeepEqual(fastTree, grammarTree) {
		t.Error("the fast path and the grammar build different trees")
	}
}

// Go maps have no prototype to pollute; the member is kept as data, at
// its place, on both paths.
func TestProtoIsData(t *testing.T) {
	for _, fast := range []Fast{FastOn, FastOff} {
		tree := mustParse(t, `{"__proto__":{"polluted":1},"a":[{"__proto__":2}]}`, ParseOptions{Fast: fast})
		if keys := tree.(*tabnas.OrderedMap).Keys; !reflect.DeepEqual(keys, []string{"__proto__", "a"}) {
			t.Errorf("fast %s: keys %v", fast, keys)
		}
		if 1.0 != member(t, member(t, tree, "__proto__"), "polluted") {
			t.Errorf("fast %s: __proto__.polluted", fast)
		}
		if 2.0 != member(t, member(t, tree, "a").([]any)[0], "__proto__") {
			t.Errorf("fast %s: a[0].__proto__", fast)
		}
	}
}

// Measured in Go, on each path. The two paths agree on every one, as they
// do in TypeScript; where Go's value differs from TypeScript's, the
// comment says so.
func TestNumbersJSONCannotCarryAndLoneSurrogates(t *testing.T) {
	for _, fast := range []Fast{FastOn, FastOff} {
		o := ParseOptions{Fast: fast}
		// encoding/json refuses 1e400, out of float64's range, so the fast
		// path falls back to the grammar, which reads an infinity, as both
		// paths do in TypeScript.
		if a := member(t, mustParse(t, `{"a":1e400}`, o), "a"); !math.IsInf(a.(float64), 1) {
			t.Errorf("fast %s: 1e400 reads as %v", fast, a)
		}
		if a := member(t, mustParse(t, `{"a":-1e400}`, o), "a"); !math.IsInf(a.(float64), -1) {
			t.Errorf("fast %s: -1e400 reads as %v", fast, a)
		}
		// -0 keeps its sign on both paths, as in TypeScript.
		if a := member(t, mustParse(t, `{"a":-0}`, o), "a").(float64); 0 != a || !math.Signbit(a) {
			t.Errorf("fast %s: -0 reads as %v", fast, a)
		}
		// A lone surrogate escape reads as U+FFFD on both paths: a Go string
		// is UTF-8, which has no surrogates, and encoding/json and the
		// grammar both substitute it. TypeScript keeps the lone surrogate.
		replacement := string(utf8.RuneError)
		if a := member(t, mustParse(t, esc(`{"a":"~ud800"}`), o), "a"); replacement != a {
			t.Errorf("fast %s: a lone high surrogate reads as %q", fast, a)
		}
		if a := member(t, mustParse(t, esc(`{"a":"~udc00x"}`), o), "a"); replacement+"x" != a {
			t.Errorf("fast %s: a lone low surrogate reads as %q", fast, a)
		}
	}

	// The yaml grammar's own numbers, as in TypeScript.
	if a := member(t, mustParse(t, "a: .inf"), "a"); !math.IsInf(a.(float64), 1) {
		t.Errorf(".inf reads as %v", a)
	}
	if a := member(t, mustParse(t, "a: -.inf"), "a"); !math.IsInf(a.(float64), -1) {
		t.Errorf("-.inf reads as %v", a)
	}
	if a := member(t, mustParse(t, "a: .nan"), "a"); !math.IsNaN(a.(float64)) {
		t.Errorf(".nan reads as %v", a)
	}

	// Under strict the json grammar refuses a number past float64's range,
	// as encoding/json does, where TypeScript's json grammar reads Infinity:
	// a deliberate asymmetry of the json repository (its AGENTS.md, on
	// out-of-range exponents).
	expectError(t, failure(t, `{"openapi":"3.1.0","a":1e400}`, strict), "unexpected", 1, 24)
}

func TestErrorsCarryThePositionOfWhatTheyRefuse(t *testing.T) {
	// At the first line of the second document's content.
	expectError(t, failure(t, "openapi: 3.1.0\n---\nopenapi: 3.0.0"), "openapi_stream", 3, 1)

	root := failure(t, "- a\n- b")
	expectError(t, root, "openapi_root", 1, 1)
	if !strings.Contains(root.Detail, "is a list at its root") {
		t.Errorf("root: %q", root.Detail)
	}

	empty := failure(t, "")
	expectError(t, empty, "openapi_root", 1, 1)
	if !strings.Contains(empty.Detail, "is empty at its root") {
		t.Errorf("empty: %q", empty.Detail)
	}

	expectError(t, failure(t, "{\"openapi\":\"3.1.0\",\n  \"a\":1,\n  \"a\":2}", strict),
		"openapi_duplicate_key", 3, 3)

	ver := failure(t, `{"openapi":"4.0.0"}`, strict)
	expectError(t, ver, "openapi_version", 1, 1)
	if !strings.Contains(ver.Detail, `openapi is "4.0.0"`) {
		t.Errorf("version: %q", ver.Detail)
	}
	if 0 == len(ver.Hint) {
		t.Error("version: no hint")
	}

	// The strict reader places a root error at the root's first token.
	expectError(t, failure(t, "\n\n  [1]", strict), "openapi_root", 3, 3)
	expectError(t, failure(t, `  {"x":1}`, strict), "openapi_version", 1, 3)
}

// The messages and hints are TypeScript's, text for text.
func TestMessagesAndHints(t *testing.T) {
	hint := map[string]string{
		"openapi_root": "Put the members of the description, such as openapi, info and paths, " +
			"at the top level of the document.",
		"openapi_stream": "Split the stream at each --- line and parse each document on its own.",
		"openapi_version": "Set openapi to a 3.0, 3.1 or 3.2 version string, such as \"3.1.0\", " +
			"or swagger to \"2.0\".",
		"openapi_duplicate_key": "Remove or rename one of the two members. JSON readers disagree on " +
			"which of them to keep.",
	}
	cases := []struct {
		src          string
		opts         ParseOptions
		code, detail string
	}{
		{"- a", ParseOptions{}, "openapi_root",
			"the document is a list at its root, where an OpenAPI description is a map"},
		{"a: 1\n---\nb: 2", ParseOptions{}, "openapi_stream",
			"the text holds more than one YAML document, where a description is one"},
		{`{"swagger":"1.2"}`, strict, "openapi_version",
			`the root names no OpenAPI or Swagger version this package reads (swagger is "1.2")`},
		{`{"openapi":null}`, strict, "openapi_version",
			"the root names no OpenAPI or Swagger version this package reads (openapi is null)"},
		{`{"openapi":{"a":[1,"<x>&"]}}`, strict, "openapi_version",
			`the root names no OpenAPI or Swagger version this package reads (openapi is {"a":[1,"<x>&"]})`},
		{`{"info":{}}`, strict, "openapi_version",
			"the root names no OpenAPI or Swagger version this package reads (no openapi or swagger member)"},
		{`{"openapi":"3.1.0","a":1,"a":2}`, strict, "openapi_duplicate_key",
			`the member name "a" appears twice in one map`},
	}
	for _, c := range cases {
		te := failure(t, c.src, c.opts)
		if c.code != te.Code || c.detail != te.Detail || hint[c.code] != te.Hint {
			t.Errorf("%q:\n  got  %s: %q\n       hint %q\n  want %s: %q", c.src, te.Code, te.Detail, te.Hint, c.code, c.detail)
		}
	}
}

func TestRootKinds(t *testing.T) {
	cases := []struct {
		src  string
		opts ParseOptions
		kind string
	}{
		{"", ParseOptions{}, "empty"},
		{"~", ParseOptions{}, "null"},
		{"# only a comment", ParseOptions{}, "null"},
		{"- a", ParseOptions{}, "a list"},
		{"hello", ParseOptions{}, "a string"},
		{"42", ParseOptions{}, "a number"},
		{"true", ParseOptions{}, "a Boolean"},
		{`"text"`, strict, "a string"},
		{"[1,2]", strict, "a list"},
		{"1.5", strict, "a number"},
		{"false", strict, "a Boolean"},
		{"null", strict, "null"},
		// A stream of `...` alone holds no document. TypeScript's yaml
		// grammar returns undefined for it, which reads "empty"; Go's
		// returns nil, as for null (the yaml repository's DIVERGENCE.md,
		// "No document and null are the same value"), which reads "null".
		{"...", ParseOptions{}, "null"},
	}
	for _, c := range cases {
		te := failure(t, c.src, c.opts)
		want := "the document is " + c.kind + " at its root, where an OpenAPI description is a map"
		if "openapi_root" != te.Code || want != te.Detail {
			t.Errorf("%q: %s: %q", c.src, te.Code, te.Detail)
		}
	}
	// An empty text under strict is the json grammar's to refuse.
	expectError(t, failure(t, "", strict), "unexpected", 1, 1)
}

func TestMemberNamesAreQuotedAndCutShort(t *testing.T) {
	odd := failure(t, `{"openapi":"3.1.0","a\"\nb":1,"a\"\nb":2}`, strict)
	if !strings.Contains(odd.Detail, `"a\"\nb"`) {
		t.Errorf("odd: %q", odd.Detail)
	}

	long := strings.Repeat("k", 200)
	cut := failure(t, `{"openapi":"3.1.0","`+long+`":1,"`+long+`":2}`, strict)
	if strings.Contains(cut.Detail, long) {
		t.Errorf("long: %q", cut.Detail)
	}
	// 57 units, the quote and 56 of the name, and the ellipsis.
	if want := `the member name "` + strings.Repeat("k", 56) + `... appears twice in one map`; want != cut.Detail {
		t.Errorf("long: %q", cut.Detail)
	}
}

// cut counts as JavaScript counts, in UTF-16 code units.
func TestCutCountsUTF16Units(t *testing.T) {
	x := func(n int) string { return strings.Repeat("x", n) }
	if got := cut(x(60), 60, 57); x(60) != got {
		t.Errorf("60 units: %q", got)
	}
	if got := cut(x(61), 60, 57); x(57)+"..." != got {
		t.Errorf("61 units: %q", got)
	}
	e := strings.Repeat("é", 60)
	if got := cut(e, 60, 57); e != got {
		t.Errorf("60 units of é: %q", got)
	}
	// A character outside the BMP is two units. 31 of them are 62 units;
	// the 29th would end at unit 58, past 57, so 28 are kept, where
	// TypeScript keeps the 29th's first half, which a Go string cannot hold.
	smile := string(rune(0x1F600))
	if got := cut(strings.Repeat(smile, 31), 60, 57); strings.Repeat(smile, 28)+"..." != got {
		t.Errorf("astral: %q", got)
	}
	if got := cut(strings.Repeat(smile, 30), 60, 57); strings.Repeat(smile, 30) != got {
		t.Errorf("60 astral units: %q", got)
	}
}

func TestEngineParseRaisesNothingOfThePlugin(t *testing.T) {
	j := Make()
	if got := parse(t, j, "a: 1\n---\nb: 2"); !reflect.DeepEqual(got,
		[]any{map[string]any{"a": 1.0}, map[string]any{"b": 2.0}}) {
		t.Errorf("stream: %v", got)
	}
	if got := parse(t, j, "- a"); !reflect.DeepEqual(got, []any{"a"}) {
		t.Errorf("list: %v", got)
	}
	if got, err := j.Parse(""); nil != got || nil != err {
		t.Errorf("empty: %v, %v", got, err)
	}
	if got := parse(t, Make(MakeOptions{Strict: true}), `{"a":1,"a":2}`); !reflect.DeepEqual(got,
		map[string]any{"a": 2.0}) {
		t.Errorf("strict: %v", got)
	}
	// Parse metadata that Parse did not make turns nothing on.
	if _, err := j.ParseMeta("- a", map[string]any{"openapi": map[string]any{"strict": true}}); nil != err {
		t.Errorf("foreign metadata: %v", err)
	}
}

func TestParseRefusesAnInstanceWithoutThePlugin(t *testing.T) {
	for _, fast := range []Fast{FastOn, FastOff} {
		_, err := Parse(`{"a":1}`, ParseOptions{Instance: yaml.MakeJsonic(), Fast: fast})
		if nil == err || !strings.Contains(err.Error(), "no OpenApi plugin") {
			t.Fatalf("fast %s: %v", fast, err)
		}
		var te *tabnas.TabnasError
		if errors.As(err, &te) {
			t.Errorf("fast %s: a parse error, where a plain one is wanted: %v", fast, err)
		}
	}
}

func TestParseUsesAGivenInstance(t *testing.T) {
	if got := flatten(mustParse(t, "a: 1", ParseOptions{Instance: Make(), Fast: FastOff})); !reflect.DeepEqual(got,
		map[string]any{"a": 1.0}) {
		t.Errorf("got %v", got)
	}

	// The instance decides the grammar: a strict one reads JSON alone,
	// Strict unset or not, and Strict decides the checks.
	json := Make(MakeOptions{Strict: true})
	expectError(t, failure(t, "a: 1", ParseOptions{Instance: json}), "unexpected", 1, 1)
	mustParse(t, `{"info":{}}`, ParseOptions{Instance: json, Fast: FastOff})
	expectError(t, failure(t, `{"info":{}}`, ParseOptions{Instance: json, Strict: true}), "openapi_version", 1, 1)

	// The plugin installed by hand, on yaml's own construction.
	j := yaml.MakeJsonic()
	if err := j.UseDefaults(OpenApi, Defaults); err != nil {
		t.Fatal(err)
	}
	expectError(t, failure(t, "- a", ParseOptions{Instance: j}), "openapi_root", 1, 1)

	// An instance reads on after a parse the plugin refused mid-stream.
	loose := Make()
	expectError(t, failure(t, "a: 1\n---\nb: 2\n---\nc: 3", ParseOptions{Instance: loose}), "openapi_stream", 3, 1)
	if got := flatten(mustParse(t, "a: 1", ParseOptions{Instance: loose})); !reflect.DeepEqual(got,
		map[string]any{"a": 1.0}) {
		t.Errorf("after a refusal: %v", got)
	}
}

func TestFast(t *testing.T) {
	var zero ParseOptions
	if FastAuto != zero.Fast {
		t.Error("the zero value is not FastAuto")
	}
	for f, name := range map[Fast]string{FastAuto: "auto", FastOn: "on", FastOff: "off", Fast(7): "Fast(7)"} {
		if name != f.String() {
			t.Errorf("%d: %q", int(f), f.String())
		}
	}

	opens := map[string]bool{
		`{"a":1}`:                   true,
		" \t\r\n{":                  true,
		"":                          false,
		"[1]":                       false,
		"a: {}":                     false,
		string(rune(0xFEFF)) + "{}": false, // a byte order mark is not JSON whitespace
		string(rune(0x00A0)) + "{}": false, // nor is a no-break space
		"\v{}":                      false,
	}
	for text, want := range opens {
		if got := FastAuto.tries(text); want != got {
			t.Errorf("auto, %q: %v", text, got)
		}
		if !FastOn.tries(text) || FastOff.tries(text) {
			t.Errorf("on and off, %q", text)
		}
		if got := Fast(7).tries(text); want != got {
			t.Errorf("an unknown setting reads as auto, %q: %v", text, got)
		}
	}
}

// What encoding/json refuses or would read otherwise, the grammar
// decides: the fast path gives the same value or error as the grammar.
func TestFastPathFallsBackToTheGrammar(t *testing.T) {
	inputs := []string{
		`{"a":1,}`,
		string(rune(0xFEFF)) + `{"a":1}`,
		"{\"a\":\"x\ty\"}",
		`{"a":01}`,
		`{"a":.5}`,
		`{"a":1e400}`,
		"{\"a\":1}\n{\"b\":2}",
		`[1,2]`,
		`"text"`,
		`{"a":1`,
		"{\"a\":\"x\xffy\"}", // not UTF-8: the grammar keeps the byte, which encoding/json reads as U+FFFD
		"{\"a\xfe\":1}",
	}
	for _, src := range inputs {
		if nil != fastParse(src) {
			t.Errorf("%q: the fast path read it", src)
		}
		fv, ferr := Parse(src, ParseOptions{Fast: FastOn})
		gv, gerr := Parse(src, ParseOptions{Fast: FastOff})
		if !reflect.DeepEqual(fv, gv) || fmt.Sprint(ferr) != fmt.Sprint(gerr) {
			t.Errorf("%q: fast path %v, %v; grammar %v, %v", src, fv, ferr, gv, gerr)
		}
	}
	if a := member(t, mustParse(t, "{\"a\":\"x\xffy\"}", ParseOptions{Fast: FastOn}), "a"); "x\xffy" != a {
		t.Errorf("not UTF-8: %q", a)
	}

	// And what it reads, it reads as the grammar does.
	for _, src := range []string{`{}`, `{"a":[1,{"b":null}],"c":{"d":[]},"a":true}`, " \n {\"a\":1} \n "} {
		tree := fastParse(src)
		if nil == tree {
			t.Fatalf("%q: the fast path refused it", src)
		}
		if g := mustParse(t, src, ParseOptions{Fast: FastOff}); !reflect.DeepEqual(tree, g) {
			t.Errorf("%q: fast path %v, grammar %v", src, tree, g)
		}
	}
}

func TestVersion(t *testing.T) {
	cases := []struct{ src, version, field string }{
		{"openapi: 3.1.0", "3.1", "openapi"},
		{`openapi: "3.0.3"`, "3.0", "openapi"},
		{"openapi: 3.2.0", "3.2", "openapi"},
		{"openapi: 3.1", "3.1", "openapi"},
		{"openapi: 3.0", "3.0", "openapi"},
		{"openapi: 3.1.1-rc0", "3.1", "openapi"},
		{`swagger: "2.0"`, "2.0", "swagger"},
		{"swagger: 2.0", "2.0", "swagger"},
		{"openapi: 4.0.0", "unknown", "openapi"},
		{`swagger: "1.2"`, "unknown", "swagger"},
		{"info: {}", "unknown", ""},
		{"openapi: 3.1.0\nswagger: \"2.0\"", "3.1", "openapi"},
	}
	for _, c := range cases {
		got := Version(mustParse(t, c.src))
		if c.version != got.Version || c.field != got.Field {
			t.Errorf("%q: %+v", c.src, got)
		}
	}
	if got := Version([]any{"a"}); !reflect.DeepEqual(got, VersionInfo{Version: "unknown"}) {
		t.Errorf("a list: %+v", got)
	}
	if got := Version(mustParse(t, "openapi: 3.1")).Value; 3.1 != got {
		t.Errorf("value: %v", got)
	}

	// A tree built by hand: a plain map, and an int.
	if got := Version(map[string]any{"openapi": 3}); "3.0" != got.Version {
		t.Errorf("int 3: %+v", got)
	}
	if got := Version(map[string]any{"swagger": 2}); "2.0" != got.Version {
		t.Errorf("int 2: %+v", got)
	}
	if got := Version(nil); !reflect.DeepEqual(got, VersionInfo{Version: "unknown"}) {
		t.Errorf("nil: %+v", got)
	}
	if got := Version(map[string]any{"openapi": nil}); "unknown" != got.Version || "openapi" != got.Field {
		t.Errorf("null openapi: %+v", got)
	}
}

// Parse shares its parsers between goroutines. An instance keeps the yaml
// grammar's per-parse state between calls, so a parser in use by one
// goroutine must not be handed to another, and each parse must return its
// own document.
func TestParseIsSafeForConcurrentUse(t *testing.T) {
	const goroutines, each = 16, 50
	var wg sync.WaitGroup
	var mu sync.Mutex
	var bad []string
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				title := fmt.Sprintf("t%d.%d", g, i)
				opts := ParseOptions{Fast: FastOff}
				src := fmt.Sprintf("openapi: 3.1.0\ninfo:\n  title: %s\n  version: '1'\npaths: {}\n", title)
				if 1 == i%2 {
					opts.Strict = true
					src = fmt.Sprintf(`{"openapi":"3.1.0","info":{"title":%q}}`, title)
				}
				out, err := Parse(src, opts)
				got := ""
				if root, ok := out.(*tabnas.OrderedMap); ok {
					if info, ok := root.Vals["info"].(*tabnas.OrderedMap); ok {
						got, _ = info.Vals["title"].(string)
					}
				}
				if title != got || nil != err {
					mu.Lock()
					bad = append(bad, fmt.Sprintf("%s: got %q, error %v", title, got, err))
					mu.Unlock()
				}
			}
		}(g)
	}
	wg.Wait()
	if 0 < len(bad) {
		t.Errorf("%d of %d parses went wrong, first %s", len(bad), goroutines*each, bad[0])
	}
}
