/**
 * The HTML shell. Inlined rather than kept as a separate asset so the built
 * server is a single file with no runtime file lookups beyond the client bundle.
 */
export function renderShell(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>xscs — context store</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>`;
}

const CSS = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --bg: #fbfbfa;
  --panel: #ffffff;
  --ink: #16181d;
  --muted: #676d7a;
  --line: #e3e5ea;
  --accent: #3b5bdb;
  --warn: #b45309;
  --danger: #b42318;
  --ok: #0f7b52;
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --ink: #e6e8ec;
    --muted: #939aa8;
    --line: #262b35;
    --accent: #8fa5ff;
    --warn: #f0b429;
    --danger: #f87171;
    --ok: #4ade80;
  }
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
}
a { color: var(--accent); }
header.top {
  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  padding: 18px 24px; border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 10;
}
header.top h1 { font-size: 15px; margin: 0; letter-spacing: .02em; }
header.top h1 span { color: var(--muted); font-weight: 400; }
.grow { flex: 1; }
.meta { color: var(--muted); font-size: 12px; font-family: var(--mono); }
main { padding: 20px 24px 64px; max-width: 1100px; margin: 0 auto; }
nav.tabs { display: flex; gap: 4px; margin: 4px 0 20px; flex-wrap: wrap; }
nav.tabs button {
  border: 1px solid transparent; background: none; color: var(--muted);
  padding: 6px 12px; border-radius: var(--radius); cursor: pointer; font: inherit;
}
nav.tabs button[aria-selected="true"] { background: var(--panel); border-color: var(--line); color: var(--ink); font-weight: 600; }
nav.tabs button .count { font-family: var(--mono); font-size: 11px; opacity: .7; margin-left: 6px; }
.statgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 20px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; }
.stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 14px; margin-bottom: 10px;
}
.card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.card header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.card h3 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; min-width: 200px; }
.card p { margin: 4px 0; white-space: pre-wrap; }
.card .why { color: var(--muted); font-size: 13px; font-style: italic; }
.card footer { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tag {
  font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
}
.tag.type { border-color: var(--accent); color: var(--accent); }
.tag.pinned { border-color: var(--warn); color: var(--warn); }
.tag.conflict { border-color: var(--danger); color: var(--danger); }
button.act {
  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink);
}
button.act:hover { border-color: var(--accent); }
button.act.primary { border-color: var(--ok); color: var(--ok); }
button.act.danger { border-color: var(--danger); color: var(--danger); }
input[type="search"], select {
  font: inherit; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
}
input[type="search"] { width: 100%; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.empty { color: var(--muted); padding: 32px 0; text-align: center; }
pre.brief {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px; overflow-x: auto; font-family: var(--mono); font-size: 12px; line-height: 1.6;
  white-space: pre-wrap;
}
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
.banner { border-left: 3px solid var(--warn); padding: 8px 12px; background: var(--panel); border-radius: 0 var(--radius) var(--radius) 0; margin-bottom: 14px; color: var(--muted); }
`;
