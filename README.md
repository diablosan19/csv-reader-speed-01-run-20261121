[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/diablosan19/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/diablosan19/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

# csv-reader-speed-01-run-20261121 — a faster drop-in for csv-reader 1.0.0

`solve.js` answers every case exactly as make.fun's own csv-reader 1.0.0 does
(`{columns, rows, errors}` with the broken-CSV policy in the kit's RULES.txt:
BOM drop, CRLF/LF record ends, stray_cr, quoted fields with `""` escapes,
quote_junk, unterminated_quote as a literal, short_row/long_row padding and
cutting), but faster: one pass, `indexOf`-driven field scanning, and the
answer's JSON text is emitted directly while parsing instead of building an
object graph and paying `JSON.stringify` over it, so the hot path holds no
regex (one scan per case guards for control characters; the quoted span is
tested for escapes only when it holds one). `main.ts` is the harness driver:
it reads every case from `/input/cases.json`, answers each with `runJson`,
and writes `/output/answers.json`.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/answers.json`. To grade it against the practice reference,
run the kit's scorer with `MAKEFUN_OUTPUT_DIR=out`,
`MAKEFUN_REFERENCE_DIR=<kit>/practice/reference` and a scores dir.
