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
refusal. The engine is `@tabnas/parser` 0.12.20.

1. `history.cjs equal`: each YAML document of the corpus up to 2 MB,
   read by one parser with no bound and by one bounded at 3, and the two
   trees compared.
2. `history.cjs cost`: each of the 51 YAML documents from 2 MB to
   13.8 MB, read once with no bound and once bounded at 3, a process for
   each reading, for the time of the parse and the peak memory of the
   process, and the two trees compared.
3. `history.cjs one` and `reference-compare.cjs`: the two Microsoft Graph
   descriptions, 25.8 MB and 58.4 MB, which this package refuses for
   their size. Each was read bounded at 3, and its tree compared node by
   node with the reference parser's.

Steps 1 and 3, and eight documents of step 2, the largest among them,
were run with the yaml build of tabnas/yaml#151 in place of the
installed package and its `schema: 'core'` option passed. The other 43
documents of step 2 were run with `@tabnas/yaml` 0.5.32 as released.
Each comparison of a bounded tree with an unbounded one is within one
build.

## The result

- **The same tree, everywhere.** All 8,176 documents of step 1 and all
  51 of step 2 read to the same tree bounded as unbounded: every YAML
  document of the corpus that the package reads today.
- **Three times the time.** Over the 51 large documents the parses take
  78 seconds in sum unbounded and 240 bounded, 3.07 times as long. The
  engine keeps the bound by freezing a copy of each finished rule with
  the few before it (`boundedRuleHistory` in its `rules.ts`).
- **Less memory the larger the text.** Over the same 51 the peaks sum to
  32.4 GB unbounded and 14.3 GB bounded, 44%. For the largest the bound
  takes a third: 443 MB where it took 1,349 MB.
- **Both Microsoft Graph descriptions are read.** They are the last two
  valid descriptions the sweep refuses.

| Description | MB | Unbounded | Bounded at 3 | Against the reference parser |
|---|---|---|---|---|
| `microsoft.com/graph/1.0.1` | 25.8 | 9.7 s, peak 2,911 MB | 29.6 s, peak 570 MB | 749,797 nodes compared, none differs |
| `microsoft.com/graph-beta/1.0.1` | 58.4 | not read: it ran out of memory under 4 GB in the sweep | 59.4 s, peak 879 MB | 1,526,519 nodes compared, none differs |

The 51 documents of step 2, largest first. Times are the parse alone, in
milliseconds, and memory is the peak of the process, in MB.

| Document | MB | Unbounded ms | Unbounded MB | Bounded ms | Bounded MB |
|---|---|---|---|---|---|
| `stripe/latest/openapi.spec3.sdk.yaml` | 13.8 | 3,929 | 1,349 | 12,154 | 443 |
| `apis-guru/APIs/loket.nl/V2/openapi.yaml` | 11.4 | 3,132 | 1,084 | 10,475 | 362 |
| `github/descriptions/api.github.com/api.github.com.yaml` | 11.0 | 3,418 | 1,237 | 10,871 | 390 |
| `github/descriptions-next/api.github.com/api.github.com.yaml` | 11.0 | 3,637 | 1,237 | 10,567 | 379 |
| `apis-guru/APIs/mailchimp.com/3.0.55/openapi.yaml` | 10.3 | 2,523 | 905 | 7,927 | 331 |
| `apis-guru/APIs/github.com/ghec.2022-11-28/1.1.4/openapi.yaml` | 9.1 | 3,065 | 1,152 | 9,626 | 339 |
| `apis-guru/APIs/github.com/ghec/1.1.4/openapi.yaml` | 9.1 | 2,932 | 1,189 | 9,681 | 339 |
| `apis-guru/APIs/github.com/api.github.com.2022-11-28/1.1.4/openapi.yaml` | 8.8 | 2,810 | 1,074 | 9,588 | 335 |
| `apis-guru/APIs/github.com/api.github.com/1.1.4/openapi.yaml` | 8.8 | 2,894 | 1,185 | 9,282 | 335 |
| `apis-guru/APIs/github.com/ghes-3.8/1.1.4/openapi.yaml` | 8.6 | 2,819 | 1,056 | 9,113 | 332 |
| `apis-guru/APIs/github.com/ghes-3.7/1.1.4/openapi.yaml` | 8.5 | 2,814 | 1,047 | 8,993 | 316 |
| `stripe/latest/openapi.spec3.yaml` | 7.9 | 2,400 | 889 | 7,499 | 364 |
| `apis-guru/APIs/github.com/github.ae/1.1.4/openapi.yaml` | 7.8 | 2,681 | 998 | 8,162 | 316 |
| `apis-guru/APIs/zuora.com/2021-08-20/openapi.yaml` | 6.8 | 1,302 | 561 | 3,786 | 305 |
| `apis-guru/APIs/amazonaws.com/ec2/2016-11-15/openapi.yaml` | 5.6 | 1,905 | 794 | 6,066 | 365 |
| `apis-guru/APIs/chaingateway.io/1.0.0/openapi.yaml` | 5.4 | 1,094 | 479 | 3,064 | 284 |
| `apis-guru/APIs/zoom.us/2.0.0/openapi.yaml` | 5.0 | 1,180 | 538 | 3,757 | 291 |
| `apis-guru/APIs/googleapis.com/compute/alpha/openapi.yaml` | 4.7 | 1,326 | 603 | 3,962 | 298 |
| `apis-guru/APIs/kubernetes.io/unversioned/swagger.yaml` | 4.5 | 1,048 | 481 | 2,737 | 288 |
| `apis-guru/APIs/unicourt.com/1.0.0/openapi.yaml` | 4.5 | 1,262 | 564 | 4,025 | 275 |
| `apis-guru/APIs/googleapis.com/compute/beta/openapi.yaml` | 4.3 | 1,261 | 555 | 3,767 | 293 |
| `apis-guru/APIs/googleapis.com/contentwarehouse/v1/openapi.yaml` | 4.3 | 1,181 | 542 | 3,524 | 271 |
| `apis-guru/APIs/autotask.net/v1/swagger.yaml` | 4.1 | 1,766 | 757 | 6,310 | 256 |
| `apis-guru/APIs/googleapis.com/compute/v1/openapi.yaml` | 3.9 | 1,218 | 522 | 3,407 | 283 |
| `azure/specification/ai-foundry/data-plane/Foundry/openapi3/virtual-public-preview/microsoft-foundry-openapi3.yaml` | 3.8 | 1,217 | 518 | 3,362 | 270 |
| `apis-guru/APIs/stripe.com/2022-11-15/openapi.yaml` | 3.7 | 1,144 | 526 | 3,647 | 264 |
| `azure/specification/ai-foundry/data-plane/Foundry/openapi3/v1/microsoft-foundry-openapi3.yaml` | 3.7 | 1,102 | 506 | 3,310 | 268 |
| `apis-guru/APIs/mist.com/0.37.7/openapi.yaml` | 3.6 | 1,401 | 634 | 4,788 | 278 |
| `apis-guru/APIs/github.com/ghes-3.6/1.1.4/openapi.yaml` | 3.3 | 1,123 | 475 | 3,264 | 266 |
| `apis-guru/APIs/kubernetes.io/v1.10.0/swagger.yaml` | 3.3 | 998 | 437 | 2,688 | 264 |
| `apis-guru/APIs/docusign.net/v2.1/openapi.yaml` | 3.3 | 913 | 394 | 2,212 | 195 |
| `apis-guru/APIs/github.com/ghes-3.5/1.1.4/openapi.yaml` | 3.2 | 1,051 | 469 | 3,106 | 264 |
| `apis-guru/APIs/here.com/tracking/2.1.192/openapi.yaml` | 3.2 | 958 | 435 | 2,886 | 262 |
| `apis-guru/APIs/github.com/ghes-3.4/1.1.4/openapi.yaml` | 3.1 | 1,068 | 472 | 3,031 | 265 |
| `apis-guru/APIs/github.com/ghes-3.2/1.1.4/openapi.yaml` | 3.1 | 919 | 450 | 2,853 | 263 |
| `apis-guru/APIs/github.com/ghes-3.3/1.1.4/openapi.yaml` | 3.0 | 934 | 458 | 2,938 | 259 |
| `apis-guru/APIs/github.com/ghes-3.1/1.1.4/openapi.yaml` | 2.9 | 971 | 452 | 2,708 | 258 |
| `apis-guru/APIs/visma.net/9.66.02.1023/openapi.yaml` | 2.7 | 849 | 461 | 2,703 | 258 |
| `apis-guru/APIs/github.com/ghes-3.0/1.1.4/openapi.yaml` | 2.7 | 942 | 426 | 2,618 | 257 |
| `apis-guru/APIs/github.com/ghes-2.22/1.1.4/openapi.yaml` | 2.6 | 883 | 431 | 2,492 | 256 |
| `apis-guru/APIs/meraki.com/1.32.0/openapi.yaml` | 2.5 | 208 | 159 | 530 | 156 |
| `apis-guru/APIs/dracoon.team/4.42.3/openapi.yaml` | 2.5 | 930 | 415 | 2,308 | 178 |
| `apis-guru/APIs/github.com/ghes-2.21/1.1.4/openapi.yaml` | 2.4 | 839 | 410 | 2,371 | 252 |
| `apis-guru/APIs/appcenter.ms/v0.1/openapi.yaml` | 2.3 | 901 | 416 | 2,762 | 240 |
| `apis-guru/APIs/azure.com/web-WebApps/2019-08-01/swagger.yaml` | 2.3 | 812 | 383 | 2,182 | 237 |
| `apis-guru/APIs/github.com/ghes-2.20/1.1.4/openapi.yaml` | 2.3 | 778 | 406 | 2,335 | 248 |
| `apis-guru/APIs/github.com/ghes-2.19/1.1.4/openapi.yaml` | 2.3 | 779 | 398 | 2,237 | 245 |
| `apis-guru/APIs/github.com/ghes-2.18/1.1.4/openapi.yaml` | 2.2 | 768 | 394 | 2,168 | 245 |
| `apis-guru/APIs/codat.io/accounting/2.1.0/openapi.yaml` | 2.2 | 680 | 359 | 1,955 | 201 |
| `apis-guru/APIs/azure.com/sql-capabilities/2018-06-01-preview/swagger.yaml` | 2.1 | 662 | 369 | 2,094 | 157 |
| `apis-guru/APIs/atlassian.com/jira/1001.0.0-SNAPSHOT/openapi.yaml` | 2.1 | 737 | 375 | 1,985 | 240 |

## What it does not measure

- A text built to be dense. T2 found that a megabyte and a half of
  one-letter items takes a rule pass or two for each byte, and that the
  bound cut a dense megabyte from 1.5 GB to 140 MB. A larger size limit
  under the bound wants every dense shape tried at that limit, as T2
  tried them at the present one.
- JSON text, which `JSON.parse` reads and the grammar does not.
- The package's other two implementations. This is the TypeScript
  engine's option, on the TypeScript package.
