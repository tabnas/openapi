// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

// Package tabnasopenapi reads OpenAPI and Swagger documents, in JSON or
// YAML, with the tabnas engine. It is the Go port of @tabnas/openapi, whose
// TypeScript implementation (ts/src/openapi.ts) is canonical.
//
// The plugin installs on a jsonic instance that carries the yaml grammar,
// so one parser reads both serialisations, or, with Strict, on the strict
// json grammar alone. Raw mode, the document exactly as written, is the
// engine's own parse; Parse adds the checks the engine cannot make (the
// root, a stream of several documents, and under Strict the version and
// repeated member names) and a fast path for JSON text. The plan for the
// rest is docs/design/implementation-plan.md.
package tabnasopenapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

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

// Defaults are the plugin's option defaults. There are none: raw mode
// needs none, and the resolver's options will belong to the resolver.
var Defaults = map[string]any{}

// errorMessages are the error codes the plugin raises, with their
// messages, and errorHints their hints. A placeholder in braces is filled
// from the error's details. Member names in a message are document
// content, so they arrive JSON-quoted and cut short (see quoted). Mirrors
// ERRORS and HINTS in ts/src/openapi.ts, text for text.
var (
	errorMessages = map[string]string{
		"openapi_root":          "the document is {kind} at its root, where an OpenAPI description is a map",
		"openapi_stream":        "the text holds more than one YAML document, where a description is one",
		"openapi_version":       "the root names no OpenAPI or Swagger version this package reads ({found})",
		"openapi_duplicate_key": "the member name {key} appears twice in one map",
	}

	errorHints = map[string]string{
		"openapi_root": "Put the members of the description, such as openapi, info and paths, " +
			"at the top level of the document.",
		"openapi_stream": "Split the stream at each --- line and parse each document on its own.",
		"openapi_version": "Set openapi to a 3.0, 3.1 or 3.2 version string, such as \"3.1.0\", " +
			"or swagger to \"2.0\".",
		"openapi_duplicate_key": "Remove or rename one of the two members. JSON readers disagree on " +
			"which of them to keep.",
	}
)

// installedKey marks an instance the plugin is installed on, so that a
// second install changes nothing.
const installedKey = "openapi-installed"

// metaKey names the per-parse state in the engine's parse metadata, as
// `openapi` does in TypeScript (`tn.parse(text, { openapi: state })`).
const metaKey = "openapi"

// parseState is the per-parse state Parse hands the plugin through the
// engine's parse metadata. A parse without it, j.Parse(text), is the
// engine's own, and the plugin raises nothing in it. The type is
// unexported, so only Parse can turn the checks on.
type parseState struct {
	strict bool
	// The text was empty. The engine returns at once for an empty text and
	// runs no rule, so Parse hands it a single line break instead, which
	// reads to an empty document, and this says what the reader wrote.
	empty bool
	docs  int
}

// OpenApi is the plugin. It installs after the base grammar, adds no
// rule, and records nothing on the parsed tree. It declares its error
// codes, makes a repeated member name keep its last value, as JSON.parse
// does, and subscribes to rule completion for the checks Parse asks for.
// Mirrors `OpenApi` in ts/src/openapi.ts.
func OpenApi(j *tabnas.Tabnas, _ map[string]any) error {
	// Once per instance: a second subscriber would count every YAML
	// document twice and refuse a single document as a stream.
	if true == j.Decoration(installedKey) {
		return nil
	}
	j.Decorate(installedKey, true)
	j.SetOptions(tabnas.Options{
		// Copies: the engine keeps the maps it is given, and a later
		// option merge must not reach these tables.
		Error: copyStrings(errorMessages),
		Hint:  copyStrings(errorHints),
		Map: &tabnas.MapOptions{
			// The last value of a repeated name wins, whole: the base
			// grammars would otherwise merge two maps given under one name.
			Merge: func(_, val any, _ *tabnas.Rule, _ *tabnas.Context) any { return val },
		},
	})
	j.SubRuleDone(check)
	return nil
}

func copyStrings(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// check makes the checks, on each rule pass. They run only in a parse
// Parse made.
//
// TypeScript throws a TabnasError from its subscriber. A Go subscriber
// raises the way a grammar action does: it sets ctx.ParseErr to a token
// marked with the code (Token.Bad), and the engine ends the parse with a
// *tabnas.TabnasError placed at that token, with the token's details
// filled into the message and hint templates, as soon as the pass's
// subscribers return. A pass that has already failed is left alone, so
// the grammar's own error stands: TypeScript reports a failed pass to
// its subscribers after the throw and drops whatever they throw then.
func check(rule *tabnas.Rule, ctx *tabnas.Context, done tabnas.RuleDone) {
	state, _ := ctx.Meta[metaKey].(*parseState)
	if nil == state || done.Probe || done.Forced || nil != ctx.ParseErr {
		return
	}

	// Each document of a YAML stream is a `val` the `stream` rule pushes.
	// The second one is refused where it starts.
	if "stream" == rule.Name && tabnas.OPEN == done.State &&
		nil != done.Alt && "val" == done.Alt.P {
		state.docs++
		if 1 < state.docs {
			raise(ctx, token(rule, ctx), "openapi_stream", nil)
		}
		return
	}

	// A repeated member name, under strict. The open pass of a pair has read
	// its key and not yet set its value, so the key is already in the map
	// only when it is repeated.
	if state.strict && "pair" == rule.Name && tabnas.OPEN == done.State {
		key, isKey := rule.U["key"].(string)
		members, isMap := membersOf(rule.Node)
		if isKey && isMap {
			if _, seen := members[key]; seen {
				raise(ctx, token(rule, ctx), "openapi_duplicate_key",
					map[string]any{"key": quoted(key)})
				return
			}
		}
	}

	// The root, once the root rule has closed for the last time.
	if 0 == rule.D && tabnas.CLOSE == done.State &&
		(nil == done.Alt || ("" == done.Alt.P && "" == done.Alt.R && nil == done.Alt.Err)) {
		// The rule closing is the last of the root's replacement chain,
		// whose node is the value the parse returns: TypeScript reads it
		// as ctx.root().node, the same value there. The position is the
		// root's own opening token, as there.
		value := rule.Node
		at := token(rule, ctx)
		if root := ctx.Root; nil != root && nil != root.O0 && "#ZZ" != root.O0.Name {
			at = root.O0
		}
		if !isMap(value) {
			kind := kindOf(value)
			if state.empty {
				kind = "empty"
			}
			raise(ctx, at, "openapi_root", map[string]any{"kind": kind})
			return
		}
		if state.strict {
			found := Version(value)
			if "unknown" == found.Version {
				what := "no openapi or swagger member"
				if "" != found.Field {
					what = found.Field + " is " + quoted(found.Value)
				}
				raise(ctx, at, "openapi_version", map[string]any{"found": what})
			}
		}
	}
}

// raise ends the parse with code at the token at. The token is copied,
// so the parse's own token is not marked, and NoToken, which the engine
// shares between parses, never is.
func raise(ctx *tabnas.Context, at *tabnas.Token, code string, details map[string]any) {
	if nil == at {
		at = tabnas.NoToken
	}
	marked := *at
	marked.Use = nil
	ctx.ParseErr = marked.Bad(code, details)
}

// token is the token to place an error at: the one the rule opened on,
// else the one in hand. A rule that matched no token opened on the
// engine's NoToken, which TypeScript's NOTOKEN mirrors: both place the
// error at 1:1.
func token(rule *tabnas.Rule, ctx *tabnas.Context) *tabnas.Token {
	if nil != rule.O0 && "#ZZ" != rule.O0.Name {
		return rule.O0
	}
	if nil != ctx.T0 {
		return ctx.T0
	}
	return tabnas.NoToken
}

// quoted renders document content for a message: as JSON.stringify
// writes it, so a control character or a quote cannot reshape the
// message, and cut short past 60 characters, counted as JavaScript counts
// them, in UTF-16 code units.
func quoted(value any) string {
	var b strings.Builder
	stringify(&b, value)
	return cut(b.String(), 60, 57)
}

// stringify writes value as JSON.stringify writes it, for the values a
// tree holds: a map's members in its order (a plain Go map's sorted, as
// it has none), a number as JavaScript writes it, -0 as 0, and a number
// JSON cannot carry as null. Anything else is written by fmt.
func stringify(b *strings.Builder, value any) {
	switch v := value.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(v))
	case string:
		quoteString(b, v)
	case []any:
		b.WriteByte('[')
		for i, item := range v {
			if 0 < i {
				b.WriteByte(',')
			}
			stringify(b, item)
		}
		b.WriteByte(']')
	case *tabnas.OrderedMap:
		if nil == v {
			b.WriteString("null")
			return
		}
		writeMembers(b, v.Keys, v.Vals)
	default:
		if n, ok := number(value); ok {
			writeNumber(b, n)
		} else if members, ok := membersOf(value); ok {
			keys := make([]string, 0, len(members))
			for k := range members {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			writeMembers(b, keys, members)
		} else {
			fmt.Fprint(b, value)
		}
	}
}

func writeMembers(b *strings.Builder, keys []string, members map[string]any) {
	b.WriteByte('{')
	for i, k := range keys {
		if 0 < i {
			b.WriteByte(',')
		}
		quoteString(b, k)
		b.WriteByte(':')
		stringify(b, members[k])
	}
	b.WriteByte('}')
}

// writeNumber writes a number as JSON.stringify does. encoding/json
// writes a finite float64 as JavaScript does; JavaScript writes -0 as 0,
// and NaN and the infinities as null.
func writeNumber(b *strings.Builder, n float64) {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		b.WriteString("null")
		return
	}
	if 0 == n {
		b.WriteByte('0')
		return
	}
	raw, _ := json.Marshal(n)
	b.Write(raw)
}

// quoteString writes a string as JSON.stringify does: the quote and the
// backslash escaped, the control characters below U+0020 written as \b,
// \t, \n, \f, \r or a six-character \u escape, and everything else as
// it is. A byte that is not UTF-8 is written as U+FFFD, which is what a
// JavaScript string read from it holds.
func quoteString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, "\\u%04x", r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// cut shortens text longer than limit UTF-16 code units to its first keep
// units and "...", as `text.slice(0, keep) + '...'` does in TypeScript. A
// character outside the Basic Multilingual Plane is two units; where
// keep falls between them, TypeScript keeps half of it, which a Go string
// cannot hold, and this stops before it.
func cut(text string, limit, keep int) string {
	units := 0
	end := -1
	for i, r := range text {
		n := 1
		if 0xFFFF < r {
			n = 2
		}
		if -1 == end && keep < units+n {
			end = i
		}
		units += n
	}
	if units <= limit {
		return text
	}
	return text[:end] + "..."
}

// membersOf returns a map node's members by name, for any of the map
// types the grammars build.
func membersOf(node any) (map[string]any, bool) {
	switch m := node.(type) {
	case *tabnas.OrderedMap:
		if nil == m {
			return nil, false
		}
		return m.Vals, true
	case map[string]any:
		return m, nil != m
	case tabnas.MapRef:
		return m.Val, nil != m.Val
	}
	return nil, false
}

func isMap(value any) bool {
	_, ok := membersOf(value)
	return ok
}

// kindOf names what a root that is not a map is, for the openapi_root
// message. Go's grammars return nil both for null and for a YAML stream
// with no document in it (see the yaml repository's DIVERGENCE.md, "No
// document and null are the same value"), so where TypeScript reads
// undefined as "empty" this reads "null"; the engine's Undefined, should
// a grammar leave it at the root, is "empty".
func kindOf(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case []any, tabnas.ListRef:
		return "a list"
	case string, tabnas.Text:
		return "a string"
	case float64, float32, int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64:
		return "a number"
	case bool:
		return "a Boolean"
	}
	if tabnas.IsUndefined(value) {
		return "empty"
	}
	return fmt.Sprintf("a %T", value)
}

// VersionInfo is the OpenAPI or Swagger version a tree's root names.
// Mirrors `VersionInfo` in ts/src/openapi.ts.
type VersionInfo struct {
	// Version is the version, to its minor: "2.0" for Swagger, "3.0",
	// "3.1" or "3.2" for OpenAPI, and "unknown" for anything else.
	Version string
	// Field is the member the version came from, "openapi" taking
	// precedence over "swagger", or "" when the root has neither.
	Field string
	// Value is that member's value, as written; nil when Field is "".
	Value any
}

var (
	openapiVersion = regexp.MustCompile(`^3\.([0-2])(?:\.\d+)?(?:[-+][0-9A-Za-z.-]*)?$`)
	swaggerVersion = regexp.MustCompile(`^2\.0(?:\.\d+)?$`)
)

// Version reads the version from a tree's root, leniently: a string or a
// number, as YAML may have read an unquoted `3.1` or `2.0`. Mirrors
// `version` in ts/src/openapi.ts.
func Version(tree any) VersionInfo {
	members, ok := membersOf(tree)
	if !ok {
		return VersionInfo{Version: "unknown"}
	}
	if value, ok := members["openapi"]; ok {
		minor := ""
		if s, ok := value.(string); ok {
			if m := openapiVersion.FindStringSubmatch(s); nil != m {
				minor = m[1]
			}
		} else if n, ok := number(value); ok {
			switch n {
			case 3:
				minor = "0"
			case 3.1:
				minor = "1"
			case 3.2:
				minor = "2"
			}
		}
		version := "unknown"
		if "" != minor {
			version = "3." + minor
		}
		return VersionInfo{Version: version, Field: "openapi", Value: value}
	}
	if value, ok := members["swagger"]; ok {
		known := false
		if s, ok := value.(string); ok {
			known = swaggerVersion.MatchString(s)
		} else if n, ok := number(value); ok {
			known = 2 == n
		}
		version := "unknown"
		if known {
			version = "2.0"
		}
		return VersionInfo{Version: version, Field: "swagger", Value: value}
	}
	return VersionInfo{Version: "unknown"}
}

// number reads a number in any of Go's numeric types: the grammars give
// float64, and a tree built by hand may hold an int.
func number(value any) (float64, bool) {
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Float32, reflect.Float64:
		return v.Float(), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(v.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return float64(v.Uint()), true
	}
	return 0, false
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
//
// An instance must not run two parses at once: the engine says so of
// every instance, and the yaml grammar keeps its per-parse state on the
// instance, so two parses at once on the default instance can return
// each other's documents. Parse, which shares its parsers, keeps to that.
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

// Fast says when Parse reads JSON text with encoding/json rather than the
// grammar. Its zero value is FastAuto. Mirrors `fast` in ts/src/openapi.ts,
// where FastOn is true and FastOff is false.
type Fast int

const (
	// FastAuto takes the fast path when the first character of the text
	// that is not JSON whitespace (space, tab, line feed, carriage return)
	// is `{`. The default.
	FastAuto Fast = iota
	// FastOn takes the fast path whatever the text opens with.
	FastOn
	// FastOff never takes the fast path.
	FastOff
)

// String names the setting, as Go prints it.
func (f Fast) String() string {
	switch f {
	case FastAuto:
		return "auto"
	case FastOn:
		return "on"
	case FastOff:
		return "off"
	}
	return fmt.Sprintf("Fast(%d)", int(f))
}

// tries reports whether the setting takes the fast path for text. A value
// that is none of the three reads as FastAuto, as any value but true and
// false reads as 'auto' in TypeScript.
func (f Fast) tries(text string) bool {
	switch f {
	case FastOn:
		return true
	case FastOff:
		return false
	}
	return opensWithBrace(text)
}

// opensWithBrace reports whether the first character of text that is not
// JSON whitespace is `{`.
func opensWithBrace(text string) bool {
	return strings.HasPrefix(strings.TrimLeft(text, " \t\n\r"), "{")
}

// ParseOptions configures Parse. Mirrors `ParseOptions` in
// ts/src/openapi.ts.
type ParseOptions struct {
	// Strict reads strict JSON alone, and refuses an unknown version and a
	// repeated member name. Default false.
	Strict bool

	// Fast reads JSON text with encoding/json rather than the grammar,
	// falling back to the grammar when encoding/json refuses the text or
	// its root is not a map, so every error still comes from the grammar.
	// FastAuto, the default, takes the fast path when the text opens with
	// `{`; FastOn takes it whatever the text opens with; FastOff never
	// takes it. Under Strict the grammar always runs.
	Fast Fast

	// Instance is the parser to use, from Make. Default: a shared parser
	// for the setting of Strict.
	Instance *tabnas.Tabnas
}

// The shared parsers, one pool for each setting of Strict. A pool rather
// than one instance each: an instance must not run two parses at once
// (see Make), and Parse is safe for concurrent use.
var (
	looseParsers  = sync.Pool{New: func() any { return Make() }}
	strictParsers = sync.Pool{New: func() any { return Make(MakeOptions{Strict: true}) }}
)

// Parse parses a description and returns its raw tree: the document as
// written, every `$ref` kept as a reference. It returns an error with
// code openapi_root when the root is not a map and openapi_stream for a
// stream of several YAML documents; under Strict, also openapi_version
// and openapi_duplicate_key. Every error a parse raises is a
// *tabnas.TabnasError, with the code, row and column of what it refuses.
// Only the first ParseOptions is read. Parse is safe for concurrent use,
// except that a given Instance is used as it is, so it must not be in
// use by another parse at the same time (see Make). Mirrors `parse` in
// ts/src/openapi.ts.
func Parse(text string, opts ...ParseOptions) (any, error) {
	var po ParseOptions
	if 0 < len(opts) {
		po = opts[0]
	}
	if nil != po.Instance && !hasOpenApi(po.Instance) {
		return nil, errors.New(
			"tabnasopenapi: Parse: the instance has no OpenApi plugin; build it with Make")
	}

	if !po.Strict && po.Fast.tries(text) {
		if tree := fastParse(text); nil != tree {
			return tree, nil
		}
	}

	j := po.Instance
	if nil == j {
		pool := &looseParsers
		if po.Strict {
			pool = &strictParsers
		}
		j = pool.Get().(*tabnas.Tabnas)
		defer pool.Put(j)
	}

	// Strict JSON refuses an empty text itself, as `unexpected`.
	empty := "" == text && !po.Strict
	state := &parseState{strict: po.Strict, empty: empty}
	src := text
	if empty {
		src = "\n"
	}
	return j.ParseMeta(src, map[string]any{metaKey: state})
}

// hasOpenApi reports whether the plugin is installed on j. Plugins are
// functions, which Go compares by address.
func hasOpenApi(j *tabnas.Tabnas) bool {
	want := reflect.ValueOf(OpenApi).Pointer()
	for _, p := range j.Plugins() {
		if reflect.ValueOf(p).Pointer() == want {
			return true
		}
	}
	return false
}

// fastParse is the fast path: encoding/json, into the tree the grammar
// builds, through the engine's own OrderedMap decoder. Every map is an
// *tabnas.OrderedMap with its members in document order, a repeated name
// keeping its last value at the position of its first, as the grammar
// and JavaScript keep it; lists are []any, numbers float64. Returns nil
// when the grammar must decide instead: whatever encoding/json refuses (a
// number past float64, such as 1E400, a trailing comma, a byte order
// mark, a raw control character in a string, a second value after the
// first), a root that is not a map, and a text that is not UTF-8, where
// encoding/json would read U+FFFD for a byte the grammar keeps.
func fastParse(text string) *tabnas.OrderedMap {
	if !opensWithBrace(text) || !utf8.ValidString(text) {
		return nil
	}
	tree := tabnas.NewOrderedMap()
	if err := json.Unmarshal([]byte(text), tree); nil != err {
		return nil
	}
	return tree
}
