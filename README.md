# sitegen-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/qaxgg895/sitegen-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/qaxgg895/sitegen-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for make.fun's makefun-site 1.0.0: for each case's input it returns exactly the output tree makefun-site's build returns — every page's index.html, the index and tag pages, build-report.txt and each static file, byte for byte — in about a third of the CPU time (3.36× faster than the house baseline on the practice set, measured on run() CPU time).

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each one with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`). Node 22 or later, no dependencies, no network, deterministic: two runs on the same input write byte-identical output.

## How it is faster

- **Markdown in one fused pass**: the body is lexed and rendered together, with no token objects, no per-character escaping (plain runs are copied raw; one native scan finds the next character that needs attention), and first-character dispatch instead of a regex test per line.
- **Memoised slugs**: titles, tag names and heading texts repeat constantly, and ASCII-only text skips Unicode normalisation entirely.
- **Compiled templates**: each template is compiled once per build into a small JavaScript function, so rendering a page is direct property reads and string appends instead of a tree walk with a scope chain. A small tree-walking interpreter covers any template the compiler cannot take.
- **A manual word counter** for `reading_minutes`, matching `/\S/` exactly, about twice as fast as the regex.

Nothing is cached from one case to the next: every memo lives and dies inside one `run()` call.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s9sfjdj8&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
