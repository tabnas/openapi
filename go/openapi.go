// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

// Package tabnasopenapi reads OpenAPI and Swagger documents, in JSON or
// YAML, with the tabnas engine. It is the Go port of @tabnas/openapi, whose
// TypeScript implementation (ts/src/openapi.ts) is canonical.
//
// The plugin installs on a jsonic instance that carries the yaml grammar,
// so one parser reads both serialisations, or, with Strict, on the strict
// json grammar alone. Raw mode, the document exactly as written, is the
// engine's own parse. The plan for the rest is
// docs/design/implementation-plan.md.
package tabnasopenapi

import (
	tabnasjson "github.com/tabnas/json/go"
	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
	yaml "github.com/tabnas/yaml/go"
)

// VERSION is this package's version. It MUST equal ts/package.json
// "version": the release orchestrator rewrites both, and
// TestVersionMatchesPackageJSON fails the build if they drift. Mirrors
// `VERSION` in ts/src/openapi.ts and rs/src/lib.rs.
const VERSION = "0.1.0"

// Defaults are the plugin's option defaults. There are none yet: raw mode
// needs none.
var Defaults = map[string]any{}

// OpenApi is the plugin. It installs after the base grammar and records
// nothing on the parsed tree. Mirrors `OpenApi` in ts/src/openapi.ts.
func OpenApi(_ *tabnas.Tabnas, _ map[string]any) error {
	// Installs, and changes nothing yet.
	return nil
}

// MakeOptions configures Make.
type MakeOptions struct {
	// Strict reads strict JSON (RFC 8259) with the json grammar alone,
	// instead of JSON and YAML with jsonic and the yaml grammar.
	Strict bool
}

// Make returns a parser instance with the plugin installed: jsonic with
// the yaml grammar, which reads JSON text as the strict json grammar does
// and YAML besides, or, with Strict, json alone. Mirrors `make` in
// ts/src/openapi.ts.
func Make(opts ...MakeOptions) *tabnas.Tabnas {
	var mo MakeOptions
	if 0 < len(opts) {
		mo = opts[0]
	}

	var j *tabnas.Tabnas
	if mo.Strict {
		j = tabnas.Make()
		must(j.Use(tabnasjson.Json))
	} else {
		// The construction yaml.MakeJsonic makes, spelled out so that this
		// package depends on jsonic directly, as the TypeScript and Rust
		// ports do. TestMakeMatchesYamlMakeJsonic holds the two together.
		j = jsonic.Make(tabnas.Options{
			String: &tabnas.StringOptions{Chars: "`"},
			Lex:    &tabnas.LexOptions{EmptyResult: nil},
		})
		must(j.Use(yaml.Yaml, map[string]any{"meta": false}))
	}

	must(j.UseDefaults(OpenApi, Defaults))
	return j
}

// must stops on an error that only a programmer can cause: the grammars
// and options above are fixed, so installing them cannot fail on input.
func must(err error) {
	if nil != err {
		panic("tabnasopenapi: " + err.Error())
	}
}
