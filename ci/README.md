# ci/

The script the Rust gate runs, [`rust/run.sh`](rust/run.sh), and notes on
this repository's own CI workflows. `.github/workflows/rust.yml` calls
that script, and you can run it locally too.

The workflows themselves live in `.github/workflows/`. To change CI, edit
them there in a reviewed pull request. Whether a session can push such an
edit depends on its token: admin `DECISIONS.md` ADR-8, as amended on
2026-09-24, allows it, but a token without GitHub's `workflow` scope is
refused, by `git push` and by the API alike. A session refused that way
stages the workflow here, under `workflows/`, for a maintainer to
promote. Nothing is staged at present.

## Stamped by admin

`crates-release.yml`, `release.yml`, `notify-status.yml`,
`scorecard.yml` and `deps-gate.yml` are stamped by admin, and still carry
the `Target: tabnas/zon` line of the template this repository was copied
from, as `clib-release.yml` still builds `libtabnaszon`. Admin restamps
them for this repository; until then do not dispatch a release, and do
not hand-edit them. `clib.yml` and `go/clib/` were removed with the ZON
grammar the stamped C library imported, and come back from admin's
`tasks/clib-template/` as `libtabnasopenapi`.

Sessions still cannot push tags. Releases therefore go through
`workflow_dispatch`, and a workflow that runs only on a tag push needs a
maintainer to push that tag.

## Promoted

These were staged here and now run from `.github/workflows/`:

- **`ci.yml`**, the shared polyglot CI. `deps` names the siblings it
  clones and builds against their `main`: `parser`, `support`, `debug`,
  `json`, `jsonic`, `yaml` and `expr`. `expr` is there for the resolver,
  which builds on its tree layer.

- **`docs.yml`** — the prose gate: Vale over the reader-facing pages at
  the levels set in `.vale.ini`, on the file list
  `ts/scripts/gated-docs.cjs` produces. See `docs/STYLE-GUIDE.md`.

  It needs no sibling checkouts and no secrets, and pins its own Vale
  version. Errors fail the job; warnings go to the run summary as a
  report. `make prose` runs the identical check locally, and the test
  suite runs the other half of the gate (`ts/test/docs.test.js`).

- **`rust.yml`**, the Rust gate: `ci/rust/run.sh` (formatting,
  build, the shared fixtures, doctests, clippy, and a lockfile check that
  exempts only the sibling crates' versions) on the MSRV pinned in
  `rs/Cargo.toml`. It clones `tabnas/parser`, `tabnas/json`,
  `tabnas/jsonic`, `tabnas/yaml`, `tabnas/support` and `tabnas/debug`
  beside the checkout, because the committed manifest takes them as path
  dependencies, although all of them are on crates.io.
  `make test-rs` is the fast local loop; the script is what CI runs.

`clib.yml` was retired rather than promoted: it built `go/clib/`, which
went with the ZON grammar.
