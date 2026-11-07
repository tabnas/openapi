// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

package tabnasopenapi_test

// example_test.go — the examples in go/README.md and go/doc/*.md, run by
// `go test` with their output checked, so a page cannot drift from the
// package it describes.

import (
	"encoding/json"
	"errors"
	"fmt"

	openapi "github.com/tabnas/openapi/go"
	tabnas "github.com/tabnas/parser/go"
	yaml "github.com/tabnas/yaml/go"
)

func show(v any) {
	out, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	fmt.Println(string(out))
}

func ExampleMake() {
	parser := openapi.Make()

	doc, err := parser.Parse("openapi: 3.1.0\ninfo:\n  title: Pets\n  version: \"1\"\npaths: {}")
	if err != nil {
		panic(err)
	}
	show(doc)

	doc, err = parser.Parse(`{"openapi":"3.1.0","paths":{}}`)
	if err != nil {
		panic(err)
	}
	show(doc)
	// Output:
	// {"openapi":"3.1.0","info":{"title":"Pets","version":"1"},"paths":{}}
	// {"openapi":"3.1.0","paths":{}}
}

func ExampleMake_references() {
	doc, err := openapi.Make().Parse("parameters:\n  - $ref: '#/components/parameters/Limit'")
	if err != nil {
		panic(err)
	}
	show(doc)
	// Output:
	// {"parameters":[{"$ref":"#/components/parameters/Limit"}]}
}

func ExampleMake_versions() {
	parser := openapi.Make()
	for _, src := range []string{"openapi: 3.1", "openapi: '3.1'", "openapi: 3.1.0", "$ref: #/a"} {
		doc, err := parser.Parse(src)
		if err != nil {
			panic(err)
		}
		show(doc)
	}
	// Output:
	// {"openapi":3.1}
	// {"openapi":"3.1"}
	// {"openapi":"3.1.0"}
	// {"$ref":null}
}

func ExampleMake_strict() {
	strict := openapi.Make(openapi.MakeOptions{Strict: true})

	doc, err := strict.Parse(`{"openapi":"3.1.0"}`)
	if err != nil {
		panic(err)
	}
	show(doc)

	_, err = strict.Parse("openapi: 3.1.0")
	var te *tabnas.TabnasError
	if errors.As(err, &te) {
		fmt.Println(te.Code, te.Row, te.Col)
	}
	// Output:
	// {"openapi":"3.1.0"}
	// unexpected 1 1
}

func ExampleOpenApi() {
	parser := yaml.MakeJsonic()
	if err := parser.UseDefaults(openapi.OpenApi, openapi.Defaults); err != nil {
		panic(err)
	}

	doc, err := parser.Parse("paths:\n  /pets: {}")
	if err != nil {
		panic(err)
	}
	show(doc)
	// Output:
	// {"paths":{"/pets":{}}}
}

func Example_tree() {
	doc, err := openapi.Make().Parse("info:\n  title: Pets\ntags: [a, b]\nn: 2")
	if err != nil {
		panic(err)
	}

	root := doc.(*tabnas.OrderedMap)
	fmt.Println(root.Keys)

	info, _ := root.Get("info")
	title, _ := info.(*tabnas.OrderedMap).Get("title")
	tags, _ := root.Get("tags")
	n, _ := root.Get("n")
	fmt.Printf("%v %v %v\n", title, tags, n)
	fmt.Printf("%T %T %T\n", title, tags, n)
	// Output:
	// [info tags n]
	// Pets [a b] 2
	// string []interface {} float64
}
