# E13: the engine's rule history, bounded

A measurement for [`../typescript-plan.md`](../typescript-plan.md), taken
on 17 November 2026 for item 5 of its step T2b and for Decision 34. The
scripts are in [`e13-rule-history/`](e13-rule-history/).

## The question

The engine keeps a record of every rule a parse has run until the parse
ends, about 900 bytes for each, and that record is most of what a large
description costs in memory. Its option `rule.history` bounds the
record, and the TypeScript engine leaves it unbounded by default. With a
bound of 3 on this package's parser, is every document read to the same
tree, and what does the bound cost and save?

## What was run

Every reading is `reading: 'spec'` on the grammar path, with the limits
on size and aliases lifted, so that a parse is measured and not a
refusal. The build is this repository's `ts/` at a32f6ee, with
`@tabnas/parser` 0.12.20 and `@tabnas/yaml` 0.5.32 as released, under
Node 24.

1. `history.cjs equal`: each YAML document of the corpus up to 2 MB,
   read by one parser with no bound and by one bounded at 3, and the two
   trees compared. A document both refuse is counted apart.
2. `history.cjs cost`: each of the 51 YAML documents from 2 MB to
   13.8 MB, read once with no bound and once bounded at 3, a process for
   each reading, and the two trees compared. The time is the parse's
   alone, and the memory is the peak of the process when the parse ends,
   before the tree is serialised for the comparison.
3. `history.cjs cost --heap 4096`: the two Microsoft Graph descriptions,
   25.8 MB and 58.4 MB, which this package refuses for their size.
4. `reference-compare.cjs`: each of those two, read bounded at 3, and its
   tree compared node by node with the reference parser's.

## The result

- **The same tree, everywhere a tree is read.** Of the 8,176 documents
  of step 1, 8,169 read to the same tree bounded as unbounded, and 7 are
  refused alike. Of the 51 of step 2, 50 read to the same tree, and one
  is refused alike. None differs.
- **The eight refused are not the bound's.** One is a list and no
  description (`openapi_root`). Seven are the refusals the yaml grammar
  causes, which tabnas/yaml#151 repairs (`unexpected`): `docker.com`,
  `epa.gov`, `meraki.com` twice, and three examples of `oai-learn`.
- **Three times the time.** Over the 50 large documents read, the parses
  take 75 seconds in sum unbounded and 235 bounded, 3.13 times as
  long. The engine keeps the bound by freezing a copy of each finished
  rule with the few before it (`boundedRuleHistory` in its `rules.ts`).
- **Less memory the larger the text.** Over the same 50 the peaks sum to
  31.3 GB unbounded and 13.1 GB bounded, 42%. For the largest the bound
  takes 29%: 373 MB where it took 1,285 MB.
- **Both Microsoft Graph descriptions are read.** They are the last two
  valid descriptions the sweep refuses.

| Description | MB | Unbounded | Bounded at 3 | Against the reference parser |
|---|---|---|---|---|
| `microsoft.com/graph/1.0.1` | 25.8 | 9.3 s, peak 2,774 MB | 28.7 s, peak 450 MB; the same tree | 749,797 nodes compared, 24 differ |
| `microsoft.com/graph-beta/1.0.1` | 58.4 | not read: the process ended under a heap of 4,096 MB | 58.4 s, peak 750 MB | 1,526,519 nodes compared, 62 differ |

Every one of those 24 and 62 differences is a YAML 1.1 word read as a
boolean: a parameter named `on` read as `true`, and `Yes` and `No` in an
enumeration. That is the released grammar's reading, and not the
bound's. With the yaml build of tabnas/yaml#151 in place of the
installed package, and its `schema: 'core'` option passed, the same
comparison finds no difference in either tree.

The 50 documents of step 2 that are read, largest first. Times are in
milliseconds and memory in MB.

| Document | MB | Unbounded ms | Unbounded MB | Bounded ms | Bounded MB |
|---|---|---|---|---|---|
| `stripe/latest/openapi.spec3.sdk.yaml` | 13.8 | 3,687 | 1,285 | 11,270 | 373 |
| `apis-guru/APIs/loket.nl/V2/openapi.yaml` | 11.4 | 2,988 | 1,104 | 10,577 | 316 |
| `github/descriptions/api.github.com/api.github.com.yaml` | 11.0 | 3,088 | 1,203 | 10,553 | 334 |
| `github/descriptions-next/api.github.com/api.github.com.yaml` | 11.0 | 3,324 | 1,202 | 10,542 | 336 |
| `apis-guru/APIs/mailchimp.com/3.0.55/openapi.yaml` | 10.3 | 2,351 | 857 | 7,519 | 289 |
| `apis-guru/APIs/github.com/ghec.2022-11-28/1.1.4/openapi.yaml` | 9.1 | 3,019 | 1,040 | 9,464 | 301 |
| `apis-guru/APIs/github.com/ghec/1.1.4/openapi.yaml` | 9.1 | 3,058 | 1,123 | 9,404 | 302 |
| `apis-guru/APIs/github.com/api.github.com.2022-11-28/1.1.4/openapi.yaml` | 8.8 | 2,835 | 1,112 | 9,101 | 299 |
| `apis-guru/APIs/github.com/api.github.com/1.1.4/openapi.yaml` | 8.8 | 3,030 | 1,101 | 9,336 | 298 |
| `apis-guru/APIs/github.com/ghes-3.8/1.1.4/openapi.yaml` | 8.6 | 2,995 | 1,104 | 9,195 | 297 |
| `apis-guru/APIs/github.com/ghes-3.7/1.1.4/openapi.yaml` | 8.5 | 2,848 | 1,040 | 8,884 | 294 |
| `stripe/latest/openapi.spec3.yaml` | 7.9 | 2,158 | 905 | 7,169 | 321 |
| `apis-guru/APIs/github.com/github.ae/1.1.4/openapi.yaml` | 7.8 | 2,491 | 951 | 8,212 | 290 |
| `apis-guru/APIs/zuora.com/2021-08-20/openapi.yaml` | 6.8 | 1,201 | 523 | 3,778 | 271 |
| `apis-guru/APIs/amazonaws.com/ec2/2016-11-15/openapi.yaml` | 5.6 | 1,696 | 752 | 5,739 | 328 |
| `apis-guru/APIs/chaingateway.io/1.0.0/openapi.yaml` | 5.4 | 1,012 | 455 | 2,934 | 276 |
| `apis-guru/APIs/zoom.us/2.0.0/openapi.yaml` | 5.0 | 1,105 | 506 | 3,703 | 267 |
| `apis-guru/APIs/googleapis.com/compute/alpha/openapi.yaml` | 4.7 | 1,215 | 560 | 4,015 | 277 |
| `apis-guru/APIs/kubernetes.io/unversioned/swagger.yaml` | 4.5 | 896 | 449 | 2,715 | 259 |
| `apis-guru/APIs/unicourt.com/1.0.0/openapi.yaml` | 4.5 | 1,239 | 528 | 3,961 | 257 |
| `apis-guru/APIs/googleapis.com/compute/beta/openapi.yaml` | 4.3 | 1,127 | 527 | 3,663 | 272 |
| `apis-guru/APIs/googleapis.com/contentwarehouse/v1/openapi.yaml` | 4.3 | 1,201 | 517 | 3,510 | 258 |
| `apis-guru/APIs/autotask.net/v1/swagger.yaml` | 4.1 | 1,647 | 737 | 5,988 | 247 |
| `apis-guru/APIs/googleapis.com/compute/v1/openapi.yaml` | 3.9 | 1,028 | 510 | 3,337 | 265 |
| `azure/specification/ai-foundry/data-plane/Foundry/openapi3/virtual-public-preview/microsoft-foundry-openapi3.yaml` | 3.8 | 1,169 | 498 | 3,382 | 256 |
| `apis-guru/APIs/stripe.com/2022-11-15/openapi.yaml` | 3.7 | 1,113 | 518 | 3,692 | 257 |
| `azure/specification/ai-foundry/data-plane/Foundry/openapi3/v1/microsoft-foundry-openapi3.yaml` | 3.7 | 1,047 | 476 | 3,195 | 254 |
| `apis-guru/APIs/mist.com/0.37.7/openapi.yaml` | 3.6 | 1,482 | 616 | 4,801 | 269 |
| `apis-guru/APIs/github.com/ghes-3.6/1.1.4/openapi.yaml` | 3.3 | 1,167 | 471 | 3,136 | 257 |
| `apis-guru/APIs/kubernetes.io/v1.10.0/swagger.yaml` | 3.3 | 861 | 421 | 2,488 | 247 |
| `apis-guru/APIs/docusign.net/v2.1/openapi.yaml` | 3.3 | 814 | 399 | 2,191 | 180 |
| `apis-guru/APIs/github.com/ghes-3.5/1.1.4/openapi.yaml` | 3.2 | 969 | 465 | 3,100 | 253 |
| `apis-guru/APIs/here.com/tracking/2.1.192/openapi.yaml` | 3.2 | 952 | 430 | 2,793 | 256 |
| `apis-guru/APIs/github.com/ghes-3.4/1.1.4/openapi.yaml` | 3.1 | 969 | 466 | 2,904 | 248 |
| `apis-guru/APIs/github.com/ghes-3.2/1.1.4/openapi.yaml` | 3.1 | 974 | 438 | 2,777 | 246 |
| `apis-guru/APIs/github.com/ghes-3.3/1.1.4/openapi.yaml` | 3.0 | 958 | 446 | 3,022 | 250 |
| `apis-guru/APIs/github.com/ghes-3.1/1.1.4/openapi.yaml` | 2.9 | 944 | 423 | 2,694 | 247 |
| `apis-guru/APIs/visma.net/9.66.02.1023/openapi.yaml` | 2.7 | 910 | 443 | 2,932 | 243 |
| `apis-guru/APIs/github.com/ghes-3.0/1.1.4/openapi.yaml` | 2.7 | 892 | 415 | 2,511 | 245 |
| `apis-guru/APIs/github.com/ghes-2.22/1.1.4/openapi.yaml` | 2.6 | 884 | 411 | 2,519 | 244 |
| `apis-guru/APIs/dracoon.team/4.42.3/openapi.yaml` | 2.5 | 800 | 400 | 2,288 | 161 |
| `apis-guru/APIs/github.com/ghes-2.21/1.1.4/openapi.yaml` | 2.4 | 800 | 387 | 2,354 | 241 |
| `apis-guru/APIs/appcenter.ms/v0.1/openapi.yaml` | 2.3 | 938 | 421 | 2,688 | 237 |
| `apis-guru/APIs/azure.com/web-WebApps/2019-08-01/swagger.yaml` | 2.3 | 765 | 381 | 2,167 | 234 |
| `apis-guru/APIs/github.com/ghes-2.20/1.1.4/openapi.yaml` | 2.3 | 821 | 393 | 2,196 | 240 |
| `apis-guru/APIs/github.com/ghes-2.19/1.1.4/openapi.yaml` | 2.3 | 780 | 391 | 2,220 | 243 |
| `apis-guru/APIs/github.com/ghes-2.18/1.1.4/openapi.yaml` | 2.2 | 808 | 380 | 2,242 | 236 |
| `apis-guru/APIs/codat.io/accounting/2.1.0/openapi.yaml` | 2.2 | 707 | 359 | 1,881 | 170 |
| `apis-guru/APIs/azure.com/sql-capabilities/2018-06-01-preview/swagger.yaml` | 2.1 | 676 | 368 | 2,113 | 157 |
| `apis-guru/APIs/atlassian.com/jira/1001.0.0-SNAPSHOT/openapi.yaml` | 2.1 | 691 | 349 | 1,962 | 233 |

## What it does not measure

- A text built to be dense. T2 found that a megabyte and a half of
  one-letter items takes a rule pass or two for each byte, and that the
  bound cut a dense megabyte from 1.5 GB to 140 MB. A larger size limit
  under the bound wants every dense shape tried at that limit, as T2
  tried them at the present one.
- JSON text, which `JSON.parse` reads and the grammar does not.
- The package's other two implementations. This is the TypeScript
  engine's option, on the TypeScript package.
