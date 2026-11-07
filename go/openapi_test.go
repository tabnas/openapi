// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

package tabnasopenapi

// openapi_test.go — the package surface, mirroring ts/test/openapi.test.ts.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"testing"

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
	return jsonFlatten(out)
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
		if !reflect.DeepEqual(jsonFlatten(got), jsonFlatten(exp)) {
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
