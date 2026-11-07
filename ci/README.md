# ci/

The script the Rust gate runs, [`rust/run.sh`](rust/run.sh), and notes on
this repository's own CI workflows. `.github/workflows/rust.yml` calls
that script, and you can run it locally too.

The workflows themselves live in `.github/workflows/`. To change CI, edit
them there in a reviewed pull request. Whether a session can push such an
edit depends on its token: admin `DECISIONS.md` ADR-8, as amended on
2026-09-24, allows it, but a token without GitHub's `workflow` scope is
refused, by `git push` and by the API alike. A session refused that way
stages the workflow here, under [`workflows/`](workflows/), for a
maintainer to promote.

## Staged, waiting for promotion

The Phase 0 bootstrap ran in a session whose token lacked the `workflow`
scope, so its three workflow edits are staged rather than live:

| Staged | Promote by |
|---|---|
| [`workflows/ci.yml`](workflows/ci.yml) | copying it over `.github/workflows/ci.yml`: `yaml` joins the siblings in `deps` |
| [`workflows/rust.yml`](workflows/rust.yml) | copying it over `.github/workflows/rust.yml`: the yaml clone, the `openapi/` checkout, and path filters for this repository's files |
| the removal of `.github/workflows/clib.yml` | deleting it: it builds `go/clib/`, which went with the ZON grammar |

Until then the live `rust.yml` stops at the gate script's sibling check,
because it clones no `yaml`, and the live `clib.yml` fails on a pull
request that touches `go/`, because `go/clib/` is gone. Both failures are
expected and name their cause. After promotion, delete `workflows/` and
this section in the same change.

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

Both of these were staged here and now run from `.github/workflows/`:

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
