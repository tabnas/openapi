// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

//! The parser `make()` builds declares `lex.window` false, its own
//! setting, in either mode, so that `Tabnas::parse_reader` reads a reader
//! whole (admin ADR-30): the plugin is not yet verified at the window's
//! edge. That the setting wins over a base that declares the window is
//! held in `src/lib.rs` (`window_tests`), where the constructor's steps can
//! be given such a base.

#[test]
fn make_declares_no_window() {
    assert!(!tabnas_openapi::make().options.lex.window);
    let strict = tabnas_openapi::MakeOptions { strict: true };
    assert!(!tabnas_openapi::make_with(&strict).options.lex.window);
}
