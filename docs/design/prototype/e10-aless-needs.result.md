# E10: what the aless viewer needs

The report of one research pass for [`../typescript-plan.md`](../typescript-plan.md),
taken on 12 November 2026 against `@tabnas/openapi` 0.1.0 as built from this
repository, and kept as it was written. The measurement scripts are in [`e10-aless-needs/`](e10-aless-needs/).
A path under `<scratch>` names the working folder of that research session,
which is not kept; a path under `/home/user` names a checkout on the machine
that ran it.

---

## What aless needs from `@tabnas/openapi` to expand and collapse references in place

Short answer: the reader already does most of the work. It finds every reference site, gives its kind and type, says whether it resolves and why not, reports the non-`$ref` names, and is fast enough on large files. It falls short in six places:
- It gives no landing location for a reference whose pointer passes through another reference.
- It does not say what happened to the members written beside `$ref`.
- It gives no resolved URI and fragment for a reference into another file.
- Its cycle flag depends on the order it walked the document.
- It has no operation that returns only the site table, without building the resolved tree.
- Its source positions do not match aless's.

The larger obstacle is aless itself. Its tree model, and the documents that define it, argue against "virtual children" (§1, §3).

I changed nothing in either checkout. My scripts and logs are in <scratch>/aless (example.js, through.js, measure.js, depth.js, retain.js, toyaml.js, gh.yaml, out-*.log).

---

## 1. How aless works where it matters

**The tree model (Q1)**
- **Representation.** A parsed value is flattened into a pre-order arena, `Doc { nodes: Vec<Node>, spellings }` (src/doc.rs:85-91). A node holds `parent`, `key` (Root, `Index(u32)` or `Name(Arc<str>)`), `kind` (Object, Array, Null, Bool, Number(f64) or Str), `depth`, subtree `size`, `children`, `expanded`, and `line`/`col` (doc.rs:48-62).
- **Identity and links.** A node's identity is its arena index, `NodeId = u32` (doc.rs:11). There are no child vectors: the first child is `i+1` and the next sibling is `i+size` (doc.rs:1-4, 244-265).
- **Eager build.** `Doc::from_value` walks the whole value and opens every container (doc.rs:95-158). A shared subtree is written out once for every place it occurs.
- **Fold state** is the `expanded` flag on each node (doc.rs:57, 350-420).
- **Visible rows** are recomputed from the arena whenever a fold changes (doc.rs:450-492, tab.rs:255-265, `refold` tab.rs:291-302).
- **Paths.** A node's path is its list of keys (doc.rs:299-309). `resolve` and `resolve_prefix` look a node up by path (doc.rs:311-329).
- **Positions.** Each node gets one start line and column. aless finds them itself, after the parse, by matching the tree's keys and leaf values against the token stream the parser reports (src/prov.rs:216-229 and 386ff; docs/explanation/positions.md). A member is placed at its key's token (prov.rs:398-405). A node that cannot be placed has 0, never its parent's position (positions.md). Positions are used by:
  - the status bar;
  - the source view `s`;
  - the reload fallback `nearest_by_line` (doc.rs:505-523).
- **Consequence:** the matching assumes tree order is source order. A tree with targets spliced into it would mis-place nodes.

**Content that is not literally a node's own subtree, or is loaded on demand (Q2)**
- **The explorer is the only on-demand content.**
  - A directory is listed when it is expanded, plus one level ahead (explorer.rs:1-3, 243-260).
  - A directory not yet listed shows a placeholder child, `…: "(not listed yet)"`, so that it can be folded (explorer.rs:370-374).
  - After every key press, `explorer_sync` lists what the expanded directories need (app.rs:837, tab.rs:1059-1079). It then rebuilds the whole `Doc` and puts the folds back by path through `Tab::apply` (tab.rs:1094-1107, 928-1007).
  - It is capped at `MAX_LISTED = 2000` directories (explorer.rs:15, 235).
  - **This is the pattern a reference expansion would copy: a placeholder child, a rebuild, folds restored by path.**
- **YAML aliases** are expanded eagerly by the YAML grammar into ordinary copies (CHANGELOG.md:238). ADR-002 says "anchors and tags are not in the tree; the source view shows them" (ADR.md:58-70). The prompt log records an aless bug where an alias's copied nodes took wrong positions (sketch/PROMPT-LOG.md:443-460). I could not check its state; the issue tracker is not reachable from this session.
- **C syntax trees** are the precedent for shared subtrees. The C reader repeats subtrees, and aless writes them out under caps measured on the shared tree (load.rs:1130-1300; design.md "C's tree"). A C conditional that "holds itself" is refused (load.rs:2017-2034).
- **The source view and history versions** are separate modes. History keeps a version's text, not its tree, and parses it again when shown (history.rs:1-4, tab.rs:869-881).
- **There are no links or includes anywhere in aless.**
- **Fit:**
  - A virtual child fits the explorer's model mechanically: a rebuild on expand, with fold state keyed by path.
  - It conflicts with docs/explanation/one-tree.md, which rejects "a second model for one format, with its own keys, its own paths, and its own search".
  - It conflicts with ADR-002 ("everything above the parser… is written once for all of them") and ADR-004 ("A shortcut that holds for one format and not the others is not taken").
  - Reference expansion would be the first behaviour specific to one format above the parser. It probably needs a new ADR in aless.

**Paths (Q3)**
- `yp`/`pP` copy a jless dot path, `yb`/`pb` a bracket path and `yq`/`pq` a jq path, all made from `doc.path(node)` (app.rs:1288-1290; fmt.rs:338-420; KEY_MAP app.rs:2176-2184).
- The status bar shows the dot path (docs/tutorials/viewer.md:124).
- In the explorer, `yp` copies the path on disk instead (app.rs:2206-2210).
- There is no JSON Pointer form.
- A node inside an expansion could be shown by either path:
  - the path through the site (a path that exists only in a resolved document);
  - the target's own path (a real path in the file).
- The target path plus the site path is the honest pair (UX decision D3).

**Search (Q4)**
- `/` matches a regex against the line-mode text of every arena node, folded or not (tab.rs:671-703; fmt.rs:213-227).
- `n` reveals, meaning it unfolds, the ancestors of a match (tab.rs:304-315). Matches are recomputed over the whole new document on reload (tab.rs:977-984).
- Content reachable only through an unexpanded reference is not in the arena, so search cannot find it there. It does find it at the target's own location, because every local target is in the file.
- If expansions were materialised, a schema referenced 640 times would give 640 duplicate matches.

**Fold commands (Q5)**
- `Space` toggles the focused container (tab.rs:571-582).
- `h` folds the container or goes to its parent; `l` unfolds or steps in (tab.rs:360-396). `H` goes to the parent without folding.
- `c`/`e` fold or unfold the node and its siblings; `C`/`E` do the same all the way down (tab.rs:585-600; doc.rs:366-401).
- `:expand` is the same as `E`. `:collapse` folds everything and goes to the top (app.rs:1539-1543).
- `--depth N`, `:depth N` and `:set depth=N` call `expand_to_depth`, which folds every container `N` levels down and below (doc.rs:413-420; cli.rs:236-247; app.rs:492, 1535).
- The deep commands loop over the arena range of the subtree. They would follow nothing they are not given, so a cycle would not loop unless expansion itself recurses.

**Limits (Q5)**
- `MAX_RULE_DEPTH = 3000` open parser rules, checked at every parse-budget step (load.rs:369, 1932-1947). This is the depth guard the brief asks about. It limits the parser's rule stack, so it tracks how deep the *source* nests, not the file's length and not anything built after the parse.
- Each format adds its own limit: JSON and YAML stop at 127 levels (docs/reference/formats.md:83-99).
- `MAX_VALUE_DEPTH = 1000` applies after the parse, to custom grammars only (load.rs:374, 1861).
- C written-out caps: 256 values per source byte, clamped to between 1M and 32M; 2,048 bytes of text per source byte, clamped to between 8 MB and 256 MB (load.rs:1153-1173).
- `--max-size` defaults to 64 MB (load.rs:235). Parsing holds about 40 bytes of memory per input byte (load.rs:238). `--timeout` is off unless set.
- A `NodeId` is a `u32`.
- **None of these bounds post-parse expansion.** A reference expansion needs its own caps, following the C precedent.

**Reload, diff and history (Q6)**
- After a reload, folds are restored by path, the focus is found by path, and failing that by nearest ancestor plus nearest line (tab.rs:928-1007; docs/explanation/reloading.md).
- The diff is path by path over the two arenas, with arrays compared index by index (history.rs:76-136). Marks attach to arena nodes.
- Every reload, and every version brought back on screen, parses the text again (tab.rs:776-881). The reader would run on each of those too.
- For expansions to survive a reload, aless would key them by site path plus the reference as written. That needs site identity equal to aless's path.
- A change inside a target is marked at the target's own path. Marks inside an expansion would have to be mapped from target-relative paths to each site.

**Formats and detection (Q7)**
- A format comes from `-k`/`--kind`, a custom grammar's whole file name, or the extension, and nothing else. There is no sniffing (load.rs:180-212). The README lists this as a deviation from jless (README.md, "The format of a file comes from its extension or from `--kind`").
- `Format` is a flat enum (load.rs:22-48). The closest thing to a layer is `read_as`, a transform after the parse for proto, expr and C (load.rs:1130-1150).
- aless has no notion of a layer on top of a base format.
- The reader's `version(tree)` recognises an OpenAPI or Swagger root (ts/doc/reference.md, `version`).
- `tabnas.plugin.json` in the openapi repo still describes ZON (the template), so it declares no detection.

**Several files, the network, and files the user did not name (Q8)**
- aless has no network code; PACKAGING.md:61 says "No test needs the network".
- It reads only:
  - files named on the command line or with `:open`;
  - grammar files, which count as input (main.rs:63);
  - files the user opens with `Enter` in the explorer (app.rs:1100-1125).
- The explorer lists directories but never follows symlinks while listing (explorer.rs:25). `Enter` on a symlink opens its target (app.rs:1114).
- docs/explanation/large-inputs.md:6, 32 asks the reader to keep the limits for untrusted input.
- There is no ADR or security note on reading files the user did not name. The plausible designs:
  - a local file reference opens its target in a new tab, on the user's request, at the fragment;
  - a URL is shown and refused.
- The reader's own plan keeps document loading off by default, with an allow-list and budgets (docs/design/implementation-plan.md:639-675 and Risks).

**`--print-json` (Q9)**
- It prints the tree as JSON, exactly what `:w` writes (cli.rs:1651-1669; ADR-007).
- ADR-007 fixes its contract: "no query, no path, no other output format, and no option that changes the tree". A resolved form there would need an ADR amendment.
- A viewer-side command (a new `:w` variant, or `yy` on a site copying the target) is not ruled out by ADR-001.

**Earlier mentions of OpenAPI or references (Q10)**
- The README's opening capture is an OpenAPI file (README.md:26-48). examples/bookshelf-openapi.yaml is a 3.0 description with `$ref` and `allOf` (examples/README.md).
- docs/why/index.md: the author built aless for reading OpenAPI files.
- The prompt log records the question "How does aless deal with $ref in yaml" (sketch/PROMPT-LOG.md:437).
- There is nothing in the ADRs, docs, CHANGELOG or code about expanding, following or jumping to a definition.
- There is no jump list or back stack (app.rs has only `last_jump`, the distance for `Ctrl+D`/`Ctrl+U`).

**How aless consumes tabnas (Q11)**
- It links the grammar packages in-process at exact versions (Cargo.toml:51-83; ADR-005).
- It calls `make()` and `parser.parse(text)` (load.rs:1042-1100, 1308-1318) and gets back a plain value tree with members in source order.
- It subscribes to the token stream for positions (prov.rs:139-170) and installs a parse-budget hook for its depth and time guard (load.rs:1932-1957). The parse runs on a thread with a 64 MB stack.
- It maps engine errors (`code`, row, column, hint, source excerpt) to its own report (load.rs:724-768).

Properties any reader aless uses must have:
- members kept in source order;
- deterministic output;
- errors with a code and a 1-based row and column;
- cancellable through a budget hook;
- no recursion bound by the call stack;
- usable on a tree aless has already parsed, not only on text;
- positions only where exact (aless prefers none to a wrong one);
- cost per reload well under its own parse time.

---

## 2. Requirements

Measured (Node, `@tabnas/openapi` 0.1.0, built dist):

| Input | Parse | `resolve` | Heap / peak RSS |
|---|---|---|---|
| aless example | 57 ms (with positions) | 6 ms | — |
| GitHub, 13.5 MB JSON, fast path | 144-152 ms | 365-386 ms | heap 68 → 97 MB; peak RSS 238 MB |
| GitHub, grammar path | 3.1 s | 0.59 s | heap ~1.0 GB; peak RSS 1.2 GB |
| GitHub, grammar path with positions | 3.5 s | 0.54 s | peak RSS 1.2 GB |
| GitHub converted to YAML, 11.2 MB, with positions | 3.4 s | 0.54 s | peak RSS 1.24 GB |

- **Example document:** 29 sites (18 schema, 5 parameter, 6 response), 10 distinct targets, 11 tag connections, every site resolved.
- **GitHub:**
  - 10,580 sites, 1,517 distinct targets, 0 unresolved, 0 cuts, 1,284 connections, 319 `$ref` maps left as data.
  - Highest fan-in: `/components/responses/not_found` 640 sites, `parameters/owner` 555, `parameters/repo` 554, `schemas/simple-user` 440.
  - 273,600 raw values; maximum raw depth 22.
  - The resolved tree, written out as a tree, is 1,515,385 values (5.5×), maximum depth 29. The longest chain of nested references is 5.
- **The parser instance retains about 840 MB after a grammar parse.** Dropping the instance frees it: heap fell from 997 MB to 157 MB (retain.js).
- For scale: aless's own documents put its parse at about 1 MB/s, roughly 14 s for this file (docs/explanation/large-inputs.md).

| # | Requirement (language-neutral) | Why aless needs it (evidence) | Provided today? | Missing or awkward |
|---|---|---|---|---|
| R1 | **Site table.** For every map that is a reference site: its location as an RFC 6901 pointer, the reference as written, kind (reference / schema / pathItem / data), type, and status. Look-up by location. | Fold state, reload and marks are all keyed by path (tab.rs:928-1007; reloading.md). A site must map to an arena node. | Yes: `provenance` (reference.md "Sites"; resolve.ts:652-668). `at` is exact; `/paths/~1api~1shelf/get/parameters/0` was checked. | Rows come in walk order, not document order (a target is entered at its first reference): the 3rd row was `/components/schemas/Shelf/allOf/0`. The consumer must index by `at`. Fine if documented as such. |
| R2 | **Landing location.** The location in the raw tree whose *literal* subtree the reference names, after following any reference a pointer passes through. Also the next hop and the end of a chain. | The cheapest way to show a target is aless's own arena subtree at that path, with positions, search and marks already there. For that, aless needs a path that exists in the raw tree. | **No.** `target` is the pointer as written, normalised. `T → #/components/schemas/A/properties/x` gives `target: /components/schemas/A/properties/x`, which does not exist in the raw tree (A is `{$ref: B}`). It lands at `/components/schemas/C/properties/x` (through.js). Chains `A→B→C` give the one-hop target only. | Add `landing` (raw location) and, optionally, `final` (end of the chain), per site. The reverse index (R7) is wrong without it. |
| R3 | **Lazy target access.** Get a site's target value on request, without building a resolved copy of the document. | Fold-driven, like the explorer (explorer.rs:243-260). Every reload and version re-runs it (tab.rs:776-881). | Partly. `resolve` is eager: it builds the whole derived tree (with `share`, one object per target) and the connections. GitHub: 0.37-0.59 s and about 30 MB more heap. The resolved objects are new objects, not the raw ones (`tree.C !== raw.C`), so they carry no positions. | Given R2, aless needs no resolved value at all: the site table plus landing locations is enough. Ask for an operation that returns only the site table and connections (no `tree`), so its cost is a walk, not a build. A raw walk took 24-107 ms on GitHub. The design notes leave lazy resolution to the consumer (docs/design/expr-for-meta-operations.md:862-866). |
| R4 | **Sibling disposition.** For a site with members beside `$ref`: each sibling's role by version and kind. The roles are: ignored (2.0, 3.0, data); overrides the target's `summary`/`description` (3.1 and later, by type); applied beside the target as `allOf` (3.1 and later schemas); merged (Path Items, with the conflicting fields). | aless must show the literal members and the target, and say which siblings count. A synthesised merge exists nowhere in the source, so it has no path or position. | **No.** The rules exist (reference.md "Siblings"; resolve.ts:441-470) but are reported only through the combined value. A 3.0 site with `description` and `nullable` beside `$ref` gives `provenance` with nothing about the dropped members. Only Path Item conflicts are reported (`pathItemMerge.fields`). | Per site: `siblings: [{name, role, overrides?}]`. |
| R5 | **Unresolved reasons.** For a site that does not resolve, why, without throwing. | aless draws an expansion that fails as a marked row, not an error tab. | Yes: `unresolved[].why` (not-found, no-anchor, bad-fragment, not-a-string, external, non-object-target, unsupported-dialect), and `status`. | `why` is in a separate array; it should also be on the provenance row. |
| R6 | **Cycle information that does not depend on walk order.** Whether a site's target reaches the site again (in a strongly connected set), and whether it is a loop made of references alone (nothing to show). | A recursive unfold must stop, and a marker before expanding helps. | Partly. `status: 'cut'` and `cuts` mark the edge that closed a cycle *in walk order*. `X→A→B→A` marks only `B→A`, so `X` looks safe. A loop of references alone (`L1↔L2`) is `cut` with a target. | Add `cyclic: boolean` and `refLoop: boolean` per site. aless still checks its own expansion ancestry, which is cheap and must be done anyway. |
| R7 | **Reverse look-up.** Which sites name a location, directly and through chains. | "Who uses this schema": `simple-user` has 440 sites. Search could jump across them. | Can be derived from `provenance.target`, but is wrong for pointers through sites (R2) and misses chains. | An index by landing location, or a documented way to build one from R2. |
| R8 | **Connections for jumping**: operationId, operationRef, tags, tag parent, security scheme names, discriminator `mapping`/`defaultMapping`, `$dynamicRef`, path-item merge, operationId reuse. | A "go to definition" from `tags[0]` or a mapping value. | Yes: `connections`, with `at`, `name`, `found`, `target`, `via`, `why` (reference.md "Connections"). The aless example gives 11 tag rows; GitHub gives 1,272 tag rows and 12 mapping rows. | A target is "looked for in the resolved tree", so it can be a location that only exists in the resolved tree; give a landing location as in R2. No positions. |
| R9 | **References into other files and URLs.** For a site that names another document: the resolved absolute URI (against `$id`, `$self` or the retrieval URI), the fragment as a pointer, and whether it is a local file. Never load anything unless asked. | Open the file in a tab at the fragment, on the user's key; refuse URLs (aless has no network; PACKAGING.md:61). | Partly. `why: 'external'`, `target: null`; the resolved URI is not reported. With a 3.1 `$id` base, aless cannot compute it correctly. Loading is deliberately absent (reference.md "What this release does not do"; implementation-plan.md Phase 3). | Add `uri` and `fragment` (pointer) per site, for external sites too. Keep loading off. |
| R10 | **Tree agreement.** The reader's notion of the tree must equal aless's tree on: member order, a repeated member name, YAML 1.1 scalars (`yes`, `.inf`), number reading, an empty document, a YAML stream. | Pointers mean nothing if the two trees differ. | Partly. `resolve` accepts any plain tree, including `JSON.parse` output (verified). But `parse` keeps the last of two repeated names (`map.merge` → last; openapi.ts:83-89), where the base grammars merge. It refuses a stream (`openapi_stream`), while aless reads a stream as an array of documents (formats.md:23). | Make resolve's results valid for a tree aless parsed with its own JSON or YAML grammar, and document the differences. Fixtures should run resolve on the base grammars' trees. |
| R11 | **Recognition.** A cheap "is this an OpenAPI or Swagger description, and which version" test on a parsed tree. | aless detects by extension only (load.rs:192-212); an OpenAPI file is `.yaml` or `.json`. | Yes: `version(tree)` (reference.md). | The plugin descriptor still names ZON (tabnas.plugin.json), so nothing machine-readable declares detection by root key. |
| R12 | **Positions, optional.** If given, positions must be the start the user means and exact. aless places a member at its key; the reader places a site at the map's opening token, which in YAML is the first member (the `$ref` key, row 25 col 11 for a list item). | aless already positions every node itself (prov.rs). | Partly. Only through `recordPositions` with the grammar path; the JSON fast path gives none (openapi.ts:299-304). On GitHub they cost 3.1-3.5 s and 1.2 GB peak versus 0.15 s and 0.24 GB. | Not needed if R1 and R2 are exact and the reader works on aless's tree. Connections have no positions. |
| R13 | **Stability across reloads.** The same text gives the same table; site identity is its location; a site's state can be compared across versions by location and reference. | Expansion state restored like folds (tab.rs:931-958). | Deterministic walk order is a contract (implementation-plan.md §3.3). | A small reload-identity fixture would pin it: insert a path above a site and check the table moves only by location. |
| R14 | **Cost bounds.** The table for a 14 MB description in well under aless's own parse time; memory linear in the input; no retained parser state; cancellable. | aless's own parse takes about 14 s on this file and it runs per reload. Its parse has a budget hook (load.rs:1932-1957). | Fast enough: about 0.5 s. But the instance retains about 840 MB after a grammar parse until dropped. `resolve` has no cancel or budget except `maxDepth` and the `copy` budget. | Drop the parse state after `parse`; add an optional step budget or cancel to the walk. |
| R15 | **Cap figures for whole expansion.** The reader should be able to say, or let aless compute cheaply, how big full expansion would be (values written out, depth), so `E`-through-references can refuse as C does. | C caps written-out trees (load.rs:1153-1300). | No. Computed by hand: GitHub 1.5M values (5.5×), depth 29, longest nested chain 5. | Optional: per target, its written-out size with cycles cut. |
| R16 | **Fixtures that pin the behaviour aless relies on.** These tie it to aless's needs; they would join the reader's test/resolve/*.tsv. | — | Partly. Existing fixtures cover resolution (test/resolve/*.tsv), not these fields. | Cases: a pointer through a site → landing location; a chain → final; sibling roles per version; a site in a cycle reached from outside; a loop of references alone; an external file reference → `uri` and `fragment`; a repeated name and a YAML stream on the base trees; document order of sites. |

---

## 3. UX decisions for the maintainer

**D1. Expanded content: a materialised virtual child, or a jump.**
- Options:
  - (a) Splice the landing subtree into the arena under the site on unfold, explorer-style: placeholder child, rebuild, folds by path.
  - (b) No splice: a key jumps to the target (`focus_node` exists, tab.rs:304), with a back stack, plus a preview of the target in the collapsed site's row.
  - (c) A whole-document resolved mode, like `:format`: 5.5× nodes on GitHub; breaks positions, paths and `:w`.
- **Recommendation:** (b) first, because it fits one-tree.md and ADR-002. Then (a) as an explicit opt-in under a new aless ADR. Reject (c).

**D2. Which key.** Plain unfold (`l`, `Space`) on a site keeps showing the literal `$ref` row, with a separate key to follow it. Otherwise ADR-003's jless behaviour breaks. **Recommendation:** a new key that jless leaves free, documented in the README's deviations list.

**D3. Paths shown and copied inside an expansion.** Options: the path through the site, the target's own path, or both. **Recommendation:** the status bar shows the target path with a "via site" note; `yp` copies the target's real path, because the path through the site does not exist in the file.

**D4. Search.** Options: search the literal tree only, or also opened expansions (duplicates). **Recommendation:** the literal tree only, plus a "who references this" listing from R7.

**D5. `E`, `:expand` and `--depth` through references.**
- Options:
  - never follow references;
  - follow them to a bound, with a cycle stop;
  - follow them to a cap like C's.
- **Recommendation:** never by default. A separate "expand references below here" stops at the first repeat on the ancestry and at a values cap (the C caps are a template: 1M floor).

**D6. Members beside `$ref`.** Options: show them as written, dimmed when ignored, with the target beside; or show the merged value. **Recommendation:** as written, with roles from R4. Never show a synthesised merge.

**D7. Other files and URLs.**
- Options for a local file reference: open a tab at the fragment on the user's key, splice it in, or refuse.
- Options for a URL: refuse, or fetch.
- **Recommendation:** a tab on the user's request, never automatic; URLs refused. This is consistent with the absence of network code and the reader's loading being off by default.

**D8. Detection.** Options:
- automatic when `version(tree)` is known, for `.json`/`.yaml`;
- only with `-k openapi`;
- a toggle key.

**Recommendation:** automatic and non-destructive (only adds keys and markers), with a setting to turn it off. Note it is aless's first post-parse layer.

**D9. `:w`, `yy` and `--print-json`.** **Recommendation:** these stay the literal tree (ADR-007). Optionally, `yy` on a site copies the target's literal JSON.

**D10. Change marks.** Options: marks only at the target's own path, or also on every expanded copy and site row ("target changed"). **Recommendation:** at the target, plus a single marker on each site row whose landing location changed.

---

## 4. Risks and open questions

- **Philosophy and ADR conflict.** Expansion is format-specific behaviour above the parser (ADR-002, ADR-004; one-tree.md). It needs an aless ADR, and the maintainer owns both repositories.
- **Tree disagreement** (R10): repeated names, streams, and the YAML grammar version aless pins (tabnas-yaml 0.5.27) against the reader's. Pointers into a tree with merged duplicate names would point at different content.
- **The cycle flag depends on walk order** (R6). A recursive unfold must not trust `status`.
- **Memory.** Materialising expansions could reach about 1.5M arena nodes on GitHub. My estimate of roughly 80 bytes per node, about 120 MB, is not measured. The reader's grammar path retains about 840 MB on its instance until dropped.
- **Reload cost.** Every reload and every version shown re-runs the reader: about 0.5 s on GitHub, plus any second parse if the reader takes text.
- **The fast path drops positions** silently (openapi.ts:299-304); a caller that wants positions must pass `fast: false`.
- **Connection targets** are found in the resolved tree, so a target can be a location the raw tree lacks.
- **The plugin descriptor** is the stale ZON template.
- **Open question:** should `$ref` maps the model types as data (examples; 319 on GitHub) be expandable under `slots: 'all'`?
- **Open question:** how should aless treat 3.1 `$dynamicRef` (reported as a connection, not a site)?

## 5. What I could not verify

- aless's behaviour at runtime. I read code and docs only; I did not build or run aless. This includes how tabnas-yaml 0.5.27 handles repeated names and YAML 1.1 scalars compared with the reader.
- The state of the aless issue about alias copies taking wrong positions; rjrodger/aless is not reachable from this session.
- The arena memory per node (estimate only).
- A large description with cycles. GitHub has none (0 cuts), and no Stripe or other cyclic corpus was available, so recursive-unfold cost on a cyclic document is unmeasured.
- Cost on YAML written by hand. My YAML was converted from the JSON with every key and string double-quoted, which may lex differently from real YAML.
- Timings are from this container, one run each.
