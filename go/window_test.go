package tabnasopenapi

import (
	"testing"

	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
)

// TestMakeDeclaresNoWindow: the parser Make builds declares lex.window
// false, its own setting, in either mode, so that ParseReader reads a
// reader whole: the plugin is not yet verified at the window's edge.
func TestMakeDeclaresNoWindow(t *testing.T) {
	if Make().Config().Window {
		t.Error("Make declares lex.window")
	}
	if Make(MakeOptions{Strict: true}).Config().Window {
		t.Error("Make with Strict declares lex.window")
	}
}

// TestMakeOnAWindowedBase: the parser's own setting wins over its base's.
// A base that declares lex.window, as jsonic's and json's own
// constructors may, given the constructor's steps, comes out with the
// window off, in either mode.
func TestMakeOnAWindowedBase(t *testing.T) {
	yes := true
	for _, mo := range []MakeOptions{{}, {Strict: true}} {
		var base *tabnas.Tabnas
		if mo.Strict {
			base = tabnas.Make()
		} else {
			base = jsonic.Make()
		}
		base.SetOptions(tabnas.Options{Lex: &tabnas.LexOptions{Window: &yes}})
		if !base.Config().Window {
			t.Fatal("the base does not declare lex.window")
		}
		j := makeOn(base, mo)
		if j.Config().Window {
			t.Errorf("strict %v: the base's lex.window reaches the openapi parser", mo.Strict)
		}
		if _, err := j.Parse(`{"openapi": "3.1.0", "paths": {}}`); err != nil {
			t.Errorf("strict %v: parse: %v", mo.Strict, err)
		}
	}
}
