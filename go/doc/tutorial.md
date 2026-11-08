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

## Read YAML

`Parse` reads a description and returns its tree:

```go
package main

import (
	"encoding/json"
	"fmt"

	openapi "github.com/tabnas/openapi/go"
)

func main() {
	doc, err := openapi.Parse("openapi: 3.1.0\ninfo:\n  title: Pets\n  version: \"1\"\npaths: {}")
	if err != nil {
		panic(err)
	}

	out, _ := json.Marshal(doc)
	fmt.Println(string(out))
	// {"openapi":"3.1.0","info":{"title":"Pets","version":"1"},"paths":{}}
}
```

Each YAML mapping becomes a `*tabnas.OrderedMap`, which keeps its
members in the order the document wrote them, and each sequence a
`[]any`.

## Read JSON

We did not tell `Parse` which format to expect, and we do not need to:

```go
doc, err := openapi.Parse(`{"openapi":"3.1.0","paths":{}}`)
// {"openapi":"3.1.0","paths":{}}
```

JSON text is also YAML, and the yaml grammar reads it to the same tree
the JSON grammar gives. JSON text that opens with `{` takes a fast path
through `encoding/json`, and comes out the same.

## References stay as written

A `$ref` comes back exactly as the document wrote it:

```go
doc, err := openapi.Parse("parameters:\n  - $ref: '#/components/parameters/Limit'")
// {"parameters":[{"$ref":"#/components/parameters/Limit"}]}
```

That is the raw tree: the document as written, nothing followed. The
reference is quoted because YAML insists. Unquoted, the `#` after a space
starts a comment, and the value would be empty.

## Keep versions as text

YAML reads `3.1` as a number. `Version` reads the version a description
names, from a string and a number alike:

```go
for _, src := range []string{"openapi: 3.1.0", "openapi: 3.1", "swagger: '2.0'", "openapi: 4.0.0"} {
	doc, _ := openapi.Parse(src)
	v := openapi.Version(doc)
	fmt.Printf("%s %q %v\n", v.Version, v.Field, v.Value)
}
// 3.1 "openapi" 3.1.0
// 3.1 "openapi" 3.1
// 2.0 "swagger" 2.0
// unknown "openapi" 4.0.0
```

Quote a version in YAML to keep the member itself a string.

## What Parse refuses

A description is one document with a map at its root. `Parse` refuses
anything else with a `*tabnas.TabnasError`, whose `Code` says why. Here
`tabnas` is the engine, `github.com/tabnas/parser/go`:

```go
_, err := openapi.Parse("openapi: 3.1.0\n---\nopenapi: 3.0.0")
var te *tabnas.TabnasError
if errors.As(err, &te) {
	fmt.Println(te.Code, te.Row, te.Col)
}
// openapi_stream 3 1
```

The code is what to test for. The message is written for people.

## Insist on JSON

`Strict` reads JSON alone, by RFC 8259. It also requires a version this
package reads, and each member name once per map:

```go
_, err := openapi.Parse(`{"openapi":"4.0.0","paths":{}}`, openapi.ParseOptions{Strict: true})
// openapi_version 1 1
```

## Where next

The [how-to guide](guide.md) reads a description from a file, uses a
parser of your own and walks the tree. The [reference](reference.md)
lists every export and the types in the tree.
