# Contributing

Maintrail's first invariant is that it is an external thinking tree, not a
session dashboard. Models own semantic judgments; runtime code owns all closed
boundaries and side effects. Changes that weaken either side of that split need
an explicit design argument.

## Local checks

```bash
bun install --frozen-lockfile
bun run check
```

UI changes must also be exercised against a rendered demo:

```bash
maintrail demo
MAINTRAIL_DEV=1 maintrail serve --state-dir ~/.maintrail-demo --no-watch
```

Do not add CDN assets, telemetry, transcript writes, or semantic keyword
heuristics. Keep generated binaries, QA screenshot sets, and dependencies out
of Git; a deliberately selected and reviewed documentation image is fine.
