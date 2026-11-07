# Go how-to guide

Short recipes for tasks you meet with the Go package. Each assumes you
have the module; the [tutorial](tutorial.md) covers that, and the
[reference](reference.md) has the details each recipe skips. The
examples import the package as `openapi` and the engine,
`github.com/tabnas/parser/go`, as `tabnas`.

## Read a description from a file

Read the file and parse its text. The format does not matter: `Parse`
reads YAML and JSON.

```go
src, err := os.ReadFile("openapi.yaml")
if err != nil {
	return err
}
doc, err := openapi.Parse(string(src))
```

`Parse` is safe to call from several goroutines at once.

## Accept strict JSON only

Pass `Strict` when a description must be JSON by RFC 8259, with no
comments, no trailing commas, and no YAML. It also refuses an unknown
version and a member name given twice in one map:

```go
doc, err := openapi.Parse(`{"openapi":"3.1.0","paths":{}}`, openapi.ParseOptions{Strict: true})
```

Without `Strict`, `{"paths":{},}` is read, any version is accepted, and
a repeated name keeps its last value.

## Find out which version a description claims

`Version` reads the root's `openapi` or `swagger` member:

```go
switch openapi.Version(doc).Version {
case "3.1", "3.2":
	// JSON Schema 2020-12 schemas
case "3.0", "2.0":
	// the older schema dialects
default:
	// "unknown": no such member, or a version this package does not read
}
```

Branch on `Version`, not on the raw member: YAML may have read an
unquoted `3.1` as a number.

## Use a parser of your own

`Parse` keeps its own parsers. To use one you built, pass it as
`Instance`; it must have the plugin installed:

```go
parser := yaml.MakeJsonic() // github.com/tabnas/yaml/go
if err := parser.UseDefaults(openapi.OpenApi, openapi.Defaults); err != nil {
	return err
}
doc, err := openapi.Parse("paths:\n  /pets: {}", openapi.ParseOptions{Instance: parser})
// {"paths":{"/pets":{}}}
```

`openapi.Make()` builds the same parser in one call. A parser runs one
parse at a time: the yaml grammar keeps the state of a parse on the
parser. Share one across goroutines only behind a lock, or keep one per
goroutine.

## Read JSON through the grammar only

JSON text that opens with `{` is read with `encoding/json` first. Pass
`FastOff` to have the grammar read it, which is slower and gives the same
tree:

```go
doc, err := openapi.Parse(`{"openapi":"3.1.0"}`, openapi.ParseOptions{Fast: openapi.FastOff})
```

## Tell parse errors apart

A failed parse returns a `*tabnas.TabnasError`. Test its `Code`, not the
message: the message is written for people and can change wording.

```go
_, err := openapi.Parse(text)
var te *tabnas.TabnasError
if errors.As(err, &te) && "openapi_root" == te.Code {
	// te.Row and te.Col say where, counting from 1.
}
```

The [reference](reference.md#errors) lists the codes.

## Read values out of the tree

A mapping is a `*tabnas.OrderedMap`. Look members up with `Get`, and
walk them in document order with `Keys`:

```go
root := doc.(*tabnas.OrderedMap)
info, _ := root.Get("info")
title, _ := info.(*tabnas.OrderedMap).Get("title")
for _, name := range root.Keys {
	fmt.Println(name)
}
```

`json.Marshal` writes a tree back as JSON, in document order.

## Keep a value YAML would change

YAML gives some unquoted values a type: `3.1` is a number, `true` a
Boolean, `null` nothing at all. Quote a value that must stay text:
`version: '3.1'`. The same goes for a `$ref`. Its value starts with `#`,
and an unquoted `#` after a space starts a comment.
