# Go package `tabnasopenapi`

The Go port of `@tabnas/openapi`: a [Tabnas](https://github.com/tabnas/parser)
plugin that reads [OpenAPI](https://spec.openapis.org/oas/latest.html) and
Swagger descriptions, in YAML or in JSON, with one parser for both.

This release returns the raw tree: the document as written, with every
`$ref` kept as a reference. It does not yet check the document or resolve
its references.

## Install

```bash
go get github.com/tabnas/openapi/go@latest
```

Go 1.24 or later.

## One example

```go
package main

import (
	"encoding/json"
	"fmt"

	openapi "github.com/tabnas/openapi/go"
)

func main() {
	parser := openapi.Make()

	for _, src := range []string{
		"openapi: 3.1.0\npaths: {}",
		`{"openapi":"3.1.0","paths":{}}`,
	} {
		doc, err := parser.Parse(src)
		if err != nil {
			panic(err)
		}
		out, _ := json.Marshal(doc)
		fmt.Println(string(out))
	}
	// {"openapi":"3.1.0","paths":{}}
	// {"openapi":"3.1.0","paths":{}}
}
```

YAML and JSON, one parser. `openapi.Make(openapi.MakeOptions{Strict:
true})` reads JSON alone, by RFC 8259.

## Documentation

- [Tutorial](doc/tutorial.md): read a description in both formats.
- [How-to guide](doc/guide.md): files, strict JSON, your own parser,
  error codes, walking the tree.
- [Reference](doc/reference.md): every export, the tree's Go types, the
  errors.
- [Concepts](doc/concepts.md): why one parser, and why the raw tree
  comes first.

## License

MIT.
