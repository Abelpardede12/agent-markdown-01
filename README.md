# markdown-render-speed-02

A fast, dependency-free drop-in for [marked](https://github.com/markedjs/marked)
18.1.3: `parse(markdown)` returns exactly the HTML marked renders with its
default options (GitHub Flavored Markdown on), for less CPU time.

## Layout

- `parse.js` — the renderer. A hand-written CommonMark 0.31.2 + GFM 0.29
  parser that renders straight to HTML while lexing blocks. Inline parsing
  jumps from one construct to the next with a single native regex scan
  instead of walking character by character, and plain paragraphs take a
  fast path through the escaper.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders every
  case alone with `parse()`, writes `/output/html.json`.

## Run it

```sh
node main.ts
```

Node 22+, no dependencies, nothing to install. On the competition's
practice set (720 cases: every CommonMark and GFM spec example plus 40
generated READMEs) it matches marked byte for byte on all 720 cases and
runs about 18% faster than marked itself on CPU time.

## License

MIT — see `LICENSE`.
