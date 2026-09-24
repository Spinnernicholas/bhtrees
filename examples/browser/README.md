# Editing the browser example

Run `npm run example:browser` from the repository root and open
http://127.0.0.1:8080. Reload the page after editing files; Reset uses the JSON
already loaded by the page.

- `mission.json`: edit the tree's order, conditions, bindings, and display labels.
- `game.js`: edit action functions, timing and speed constants, and the crystal list.
- `app.js`: connects the simulation to the page controls and tree view.

The mission reads from the root down. A sequence runs its `steps` in order;
a selector tries steps until one succeeds. The repeat runs one expedition at a
time. Once no crystals remain, its condition fails, ending the repeat. The
selector then checks that all crystals were delivered before the final report.

Every node needs a unique `id`. Change `label` freely to rename it in the view.
An action or condition's `implementation` names its registration near the bottom
of `game.js`; its implementation version defaults to 1.

Steps can save a result and pass it to later actions:

```json
{"node": {"id": "scan", "type": "action", "implementation": "game.scan"}, "save": "target"}
```

A later step uses `"input": {"path": ["vars", "target"]}` to read that saved
target. In its JavaScript action, `ctx.input` receives the target and `ctx.local`
holds state for the current activation. Return `RUNNING` to keep working or
`ctx.success(value)` / `ctx.failure(reason)` to finish.

This nested `bhtrees-example` format is for editing this example.
`mission-loader.js` converts it into the library's flat `bhtrees` interchange
format, strips display labels, and validates the tree before any actions run.
