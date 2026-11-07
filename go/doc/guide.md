# Go how-to guide

Short recipes for tasks you meet with the Go package. Each assumes you
have the module; the [tutorial](tutorial.md) covers that, and the
[reference](reference.md) has the details each recipe skips. The
examples import the package as `openapi` and the engine,
`github.com/tabnas/parser/go`, as `tabnas`.

## Read a description from a file

Read the file and parse its text. The format does not matter: one parser
reads YAML and JSON.

```go
src, err := os.ReadFile("openapi.yaml")
if err != nil {
	return err
}
doc, err := parser.Parse(string(src))
```

Make `parser` once, with `openapi.Make()`, and keep it for the next file.

## Accept strict JSON only

Pass `Strict` when a description must be JSON by RFC 8259, with no
comments, no trailing commas and no YAML:

```go
strict := openapi.Make(openapi.MakeOptions{Strict: true})
doc, err := strict.Parse(`{"paths":{}}`)
```

The default parser accepts `{"paths":{},}`; the strict one refuses it
with the code `unexpected`.

## Install the plugin on your own parser

`Make` is a shortcut. To build the parser yourself, install the base
grammar first and the plugin after it:

```go
parser := yaml.MakeJsonic() // github.com/tabnas/yaml/go
if err := parser.UseDefaults(openapi.OpenApi, openapi.Defaults); err != nil {
	return err
}
doc, err := parser.Parse("paths:\n  /pets: {}")
// {"paths":{"/pets":{}}}
```

For strict JSON, start from `tabnasjson.Make()` in
`github.com/tabnas/json/go` instead.

## Tell parse errors apart

A failed parse returns a `*tabnas.TabnasError`. Test its `Code`, not the
message: the message is written for people and can change wording.

```go
_, err := strict.Parse(`{"a":1} // note`)
var te *tabnas.TabnasError
if errors.As(err, &te) && "unexpected" == te.Code {
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
