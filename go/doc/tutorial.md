# Tutorial: read an OpenAPI description in Go

An OpenAPI description is a tree of maps and lists. It is written in
YAML or in JSON. In this tutorial we read one in both forms with the Go
package and look at what comes back. Every example here also runs as a
Go example test, so the output shown is the output you get.

You need Go 1.24 or later.

## Add the module

```bash
go get github.com/tabnas/openapi/go
```

The package name is `tabnasopenapi`. The examples import it as `openapi`.

## Make a parser and read YAML

`Make` builds a parser with everything installed:

```go
package main

import (
	"encoding/json"
	"fmt"

	openapi "github.com/tabnas/openapi/go"
)

func main() {
	parser := openapi.Make()

	doc, err := parser.Parse("openapi: 3.1.0\ninfo:\n  title: Pets\n  version: \"1\"\npaths: {}")
	if err != nil {
		panic(err)
	}

	out, _ := json.Marshal(doc)
	fmt.Println(string(out))
	// {"openapi":"3.1.0","info":{"title":"Pets","version":"1"},"paths":{}}
}
```

Build the parser once and keep it. Building the grammar costs more than a
parse.

## Read JSON

We did not tell the parser which format to expect, and we do not need to.
The same parser reads JSON:

```go
doc, err := parser.Parse(`{"openapi":"3.1.0","paths":{}}`)
// {"openapi":"3.1.0","paths":{}}
```

JSON text is also YAML, and the yaml grammar reads it to the same tree
the JSON grammar gives.

## References stay as written

A `$ref` comes back exactly as the document wrote it:

```go
doc, err := openapi.Make().Parse("parameters:\n  - $ref: '#/components/parameters/Limit'")
// {"parameters":[{"$ref":"#/components/parameters/Limit"}]}
```

That is the raw tree: the document as written, nothing followed. The
reference is quoted because YAML insists. Unquoted, the `#` after a space
starts a comment, and the value would be empty.

## Keep versions as text

YAML reads `3.1` as a number:

```go
for _, src := range []string{"openapi: 3.1", "openapi: '3.1'", "openapi: 3.1.0"} {
	doc, _ := parser.Parse(src)
	out, _ := json.Marshal(doc)
	fmt.Println(string(out))
}
// {"openapi":3.1}
// {"openapi":"3.1"}
// {"openapi":"3.1.0"}
```

Quote a version to keep it a string. `3.1.0` is not a number, so it stays
a string either way.

## Insist on JSON

`Strict` reads JSON alone, by RFC 8259, and refuses anything else:

```go
strict := openapi.Make(openapi.MakeOptions{Strict: true})

_, err := strict.Parse("openapi: 3.1.0")
var te *tabnas.TabnasError
if errors.As(err, &te) {
	fmt.Println(te.Code, te.Row, te.Col)
}
// unexpected 1 1
```

`tabnas` here is the engine, `github.com/tabnas/parser/go`. Every parse
error is a `*tabnas.TabnasError` with a `Code`, and the code is what to
test for.

## Where next

The [how-to guide](guide.md) reads a description from a file and installs
the plugin on a parser you already have. The [reference](reference.md)
lists every export and the types in the tree.
