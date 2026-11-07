# Go package `tabnasopenapi`

The Go port of `@tabnas/openapi`: a [Tabnas](https://github.com/tabnas/parser)
plugin that reads [OpenAPI](https://spec.openapis.org/oas/latest.html) and
Swagger descriptions, in YAML or in JSON, with one parser for both.

This release returns the raw tree: the document as written, with every
`$ref` kept as a reference, after checking that it is one description
with a map at its root. It does not resolve references yet.

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
	for _, src := range []string{
		"openapi: 3.1.0\npaths: {}",
		`{"openapi":"3.1.0","paths":{}}`,
	} {
		doc, err := openapi.Parse(src)
		if err != nil {
			panic(err)
		}
		out, _ := json.Marshal(doc)
		fmt.Println(string(out), openapi.Version(doc).Version)
	}
	// {"openapi":"3.1.0","paths":{}} 3.1
	// {"openapi":"3.1.0","paths":{}} 3.1
}
```

YAML and JSON, one function. `openapi.Parse(text,
openapi.ParseOptions{Strict: true})` reads JSON alone, by RFC 8259, and
requires a known version.

## Documentation

- [Tutorial](doc/tutorial.md): read a description in both formats.
- [How-to guide](doc/guide.md): files, strict JSON, versions, your own
  parser, error codes, walking the tree.
- [Reference](doc/reference.md): every export, the tree's Go types, the
  errors.
- [Concepts](doc/concepts.md): why one parser, and why the raw tree
  comes first.

## License

MIT.
