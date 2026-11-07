// Cross-runtime conformance, driven by the shared `test/spec/*.tsv`
// fixtures at the repo root (see ../../test/AGENTS.md).
//
// The fixture loader, the escape codec, the `ERROR:<code>` contract and
// the row loop all come from tabnas_support, whose TypeScript and Go
// halves `ts/test/parity.test.ts` and `go/parity_test.go` use to run the
// SAME files, so the three implementations cannot drift without one of
// them going red, and neither can the loaders.
//
// What is left here is only what is specific to openapi: every row runs
// through the `parse` wrapper with the options in its `opts` column, and
// `raw-fast.tsv` runs twice more, with the fast path forced on and off,
// since its rows hold that both paths give one tree.

mod common;

use tabnas_openapi::{parse, Fast};
use tabnas_support::{report, Runner};

use common::{row_options, spec_dir, to_failure, to_value};

/// A runner over `parse` with each row's options, and with `fast` over
/// them when it is given.
fn runner(fast: Option<Fast>) -> Runner {
    Runner::new_with_row(move |input, row| {
        let mut options = row_options(row.named("opts"))?;
        if let Some(fast) = fast {
            options.fast = fast;
        }
        parse(input, &options)
            .map(|value| to_value(&value))
            .map_err(to_failure)
    })
}

/// Every fixture in the spec directory. `dir` discovers the files by
/// listing, so adding a .tsv runs it in every runtime without touching
/// any runner, and an empty directory fails rather than passing.
#[test]
fn spec() {
    runner(None).dir(spec_dir());
}

/// `raw-fast.tsv` with the fast path forced on and then off, whatever its
/// rows ask for: the two paths must read each row to one tree. Rust's
/// harness has no subtests, so both runs are reported together, each
/// failure prefixed with the setting it ran under.
#[test]
fn raw_fast_both_paths() {
    let path = spec_dir().join("raw-fast.tsv");
    let mut failures = Vec::new();
    for fast in [Fast::On, Fast::Off] {
        match runner(Some(fast)).run_file(&path) {
            Ok(rows) => {
                failures.extend(rows.into_iter().map(|row| format!("fast {fast:?}: {row}")))
            }
            Err(error) => failures.push(format!("fast {fast:?}: {error}")),
        }
    }
    report(Ok(failures));
}
