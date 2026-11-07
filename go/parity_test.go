// Copyright (c) 2025-2026 Richard Rodger and other contributors, MIT License

package tabnasopenapi

// parity_test.go — cross-runtime conformance, driven by the shared
// `test/spec/*.tsv` fixtures at the repo root (see ../test/AGENTS.md).
//
// The fixture loader, the escape codec, the ERROR:<code> contract and the
// row loop all come from github.com/tabnas/support/go, whose TypeScript
// and Rust halves ts/test/parity.test.ts and rs/tests/parity_test.rs use to
// run the SAME files — so the implementations cannot drift without one of
// them going red, and neither can the loaders.
//
// What is left here is only what is specific to openapi: every row runs
// through Parse with the options in its `opts` column, raw-fast.tsv runs
// twice more, with the fast path forced on and off, since its rows hold
// that both paths give one tree, and the rows Go cannot answer as
// TypeScript does are held to what Go gives instead (goDivergent).

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	tabnas "github.com/tabnas/parser/go"
	support "github.com/tabnas/support/go"
)

// goDivergent are the shared rows Go answers differently from TypeScript,
// each for a reason in a base grammar, which this package does not
// patch (AGENTS.md: behaviour the base grammars own is fixed there). A
// row here still runs, in every pass that runs its file, and is held to
// what Go measurably gives: the test fails when Go starts to give what
// the fixture expects, saying the entry is to be deleted, when it gives
// anything else, and when the entry matches no row.
var goDivergent = []struct {
	file, input, opts string // the row: its file, its decoded input and its opts cell
	want              string // what Go gives, in the expected column's vocabulary
	why               string
}{
	{
		file:  "raw-fast.tsv",
		input: "{\"a\":1}\n{\"b\":2}",
		want:  "ERROR:openapi_root",
		why: "TypeScript's yaml grammar refuses a second flow mapping at the start " +
			"of a line, as `unexpected` at 2:1; Go's yaml 0.5.27 reads the two " +
			"as jsonic's implicit list, a root raw mode refuses as a list",
	},
	{
		file:  "raw-json.tsv",
		input: "\n{\"a\":1}",
		opts:  `{"fast":false}`,
		want:  `{"a":1}`,
		why: "the row pins a defect of TypeScript's yaml grammar, which refuses JSON " +
			"text whose first line is blank (`unexpected` at 2:1); Go's yaml 0.5.27 " +
			"does not have it and reads the map",
	},
}

// TestSpec runs every fixture in the spec directory. FindSpecDir walks up
// from the package directory, and LoadSpecDir discovers the files by
// listing, so adding a .tsv runs it in every runtime without touching any
// runner.
func TestSpec(t *testing.T) {
	dir, err := support.FindSpecDir("")
	if err != nil {
		t.Fatal(err)
	}
	specs, err := support.LoadSpecDir(dir, nil)
	if err != nil {
		t.Fatal(err)
	}

	matched := make([]int, len(goDivergent))
	for _, spec := range specs {
		runSpec(t, specRunner(nil), spec, matched)
	}

	// raw-fast.tsv again, with the fast path forced on and then off: its
	// rows hold that both paths read JSON text to one tree.
	fastSpec, err := support.LoadSpec(filepath.Join(dir, "raw-fast.tsv"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, fast := range []Fast{FastOn, FastOff} {
		t.Run("fast "+fast.String(), func(t *testing.T) {
			runSpec(t, specRunner(&fast), fastSpec, matched)
		})
	}

	for i, d := range goDivergent {
		if 0 == matched[i] {
			t.Errorf("goDivergent entry %s %q (opts %q) matches no row: delete it",
				d.file, d.input, d.opts)
		}
	}
}

// specRunner is the shared runner. fast, when given, overrides the row's
// own setting of the fast path.
func specRunner(fast *Fast) support.Runner {
	return support.Runner{
		ParseRow: func(input string, row *support.Row) (any, error) {
			opts, err := rowOptions(row)
			if err != nil {
				return nil, err
			}
			if nil != fast {
				opts.Fast = *fast
			}
			return Parse(input, opts)
		},

		// Every node in plain Go shapes, so the parser's own containers
		// compare against the fixture's decoded value. Normalize runs
		// outermost first, so the top node is enough — the plain values it
		// yields pass through unchanged.
		Normalize: flatten,

		CaseName: func(row *support.Row, input string) string {
			if nil != fast {
				return fmt.Sprintf("fast %s, row %d: %q", *fast, row.Line, input)
			}
			return fmt.Sprintf("row %d: %q", row.Line, input)
		},
	}
}

// runSpec runs a fixture's rows, the goDivergent ones held to what Go
// gives and every other one to its expected column. matched counts the
// rows each goDivergent entry has met.
func runSpec(t *testing.T, runner support.Runner, spec *support.File, matched []int) {
	t.Helper()

	kept := *spec
	kept.Rows = nil
	type pin struct {
		row *support.Row
		at  int
	}
	var pinned []pin
	for _, row := range spec.Rows {
		at := divergentAt(spec.Name, row)
		if 0 <= at {
			matched[at]++
			pinned = append(pinned, pin{row, at})
			continue
		}
		kept.Rows = append(kept.Rows, row)
	}

	runner.Spec(t, &kept)

	for _, p := range pinned {
		d := goDivergent[p.at]
		input := p.row.Unesc(0)
		t.Run(fmt.Sprintf("goDivergent %s %s", spec.Name, runner.CaseName(p.row, input)), func(t *testing.T) {
			if nil == runner.CheckRow(p.row, input, p.row.Col(1)) {
				t.Errorf("%s: Go now gives %s, as the fixture expects: delete its goDivergent entry",
					p.row.Where(), p.row.Col(1))
				return
			}
			if err := runner.CheckRow(p.row, input, d.want); nil != err {
				t.Errorf("%s: goDivergent says Go gives %s (%s), but: %v",
					p.row.Where(), d.want, d.why, err)
			}
		})
	}
}

// divergentAt is the index of the goDivergent entry for a row, or -1.
func divergentAt(file string, row *support.Row) int {
	for i, d := range goDivergent {
		if d.file == file && d.input == row.Unesc(0) &&
			d.opts == strings.TrimSpace(row.Named("opts")) {
			return i
		}
	}
	return -1
}

// rowOptions reads a row's `opts` cell: a JSON object whose `strict` is a
// Boolean and whose `fast` is true, false or "auto", as the TypeScript
// runner hands them to parse. Other members are ignored there too.
func rowOptions(row *support.Row) (ParseOptions, error) {
	var opts ParseOptions
	raw := strings.TrimSpace(row.Named("opts"))
	if "" == raw {
		return opts, nil
	}
	var cell struct {
		Strict bool            `json:"strict"`
		Fast   json.RawMessage `json:"fast"`
	}
	if err := json.Unmarshal([]byte(raw), &cell); err != nil {
		return opts, fmt.Errorf("opts %s: %w", raw, err)
	}
	opts.Strict = cell.Strict
	switch fast := strings.TrimSpace(string(cell.Fast)); fast {
	case "", "null", `"auto"`:
		opts.Fast = FastAuto
	case "true":
		opts.Fast = FastOn
	case "false":
		opts.Fast = FastOff
	default:
		return opts, fmt.Errorf("opts %s: fast is %s, where true, false or \"auto\" is read", raw, fast)
	}
	return opts, nil
}

// flatten turns the parser's containers into plain ones, the shapes the
// fixture's expected JSON decodes to: *tabnas.OrderedMap to
// map[string]any, all the way down. It walks the tree rather than
// round-tripping it through JSON, so a number JSON cannot carry (an
// infinity, NaN) is compared as the float64 it is rather than leaving the
// tree unflattened, and nothing else changes on the way.
func flatten(v any) any {
	return tabnas.Plainify(v)
}
