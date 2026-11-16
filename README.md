# markdown-render-fast

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jefaprayoga-stack/markdown-render-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jefaprayoga-stack/markdown-render-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A faster drop-in for [marked](https://github.com/markedjs/marked) 18.1.3: `parse(markdown)`
returns byte-for-byte the HTML `marked.parse(markdown)` returns with marked's
default options (GFM on, breaks off, pedantic off, async off), and renders the
competition's 720-case set measurably faster than marked itself.

Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty,
$250 in USDC. See the bounty at https://make.fun/bounty/markdown-render-speed-02.

## How it works

`parse.js` subclasses marked's own `Lexer` and overrides its two dispatch
loops with first-character dispatch plus cheap pre-checks, so a plain
paragraph or text run pays one regex instead of a dozen failed ones, and
replaces the paragraph regex with a manual line scanner that applies the same
interruption rules. The block and inline tokenizers, the renderer and every
output rule are marked's own, so the HTML is identical by construction — the
fork only changes *which* tokenizers are attempted, never what they return.

- `parse.js` — the fast parser (dependency-free ES module, `parse(markdown)`)
- `main.ts` — the harness driver: reads `/input/cases.json`, writes
  `/output/html.json`
- `vendor/marked/` — marked 18.1.3, vendored byte for byte under its MIT
  licence (see `vendor/marked/LICENSE` and `vendor/marked/NOTICE`)

## Layout

```
.
├── LICENSE
├── README.md
├── main.ts
├── parse.js
└── vendor/
    └── marked/
        ├── LICENSE
        ├── NOTICE
        └── marked.esm.js
```

## License

MIT. Marked is (c) MarkedJS, MIT licensed; see `vendor/marked/LICENSE`.
