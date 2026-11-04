# Fork into a side pane

Auto-loaded personal Pi extension. Run `/reload` after installation.

`/fork` keeps Pi's user-message selector, then opens the independent fork in a
right-hand pane instead of replacing the original session. The selected message
is restored into the new editor, not sent automatically. As with native Pi fork,
only text is restored (not attached images). `/clone`, RPC and print are unchanged.
The fork preserves cwd, model and thinking level. Personal/project resources load
normally; one-off CLI resource flags and runtime tool overrides are not copied.

Detection and launch:

1. Rex: `REX_BLOCK` + `REX_SERVER`, matching `REX_BIN_DIR/rex`, `rex split`
   with explicit server/block, cwd and direct command arguments.
2. Herdr: `HC_TERMINAL_ID` (or app bundle identity); `herdr-app ls` resolves
   that terminal to its pane, then `herdr-app do pane.split` creates the split.
   Only local Herdr panes are supported; unmatched/remote panes fail safely.
3. Ghostty on macOS: native AppleScript `split ... direction right` with a
   surface configuration. Requires Ghostty 1.3+ and Automation permission.
   Uses `GHOSTTY_SURFACE_ID` when available, otherwise captures the currently
   focused Ghostty terminal at invocation. Keep the source pane focused then.

Rex/Herdr detection precedes `TERM_PROGRAM=ghostty`, which embedded terminals
also report. Unknown terminals fail with a notification. Failures never replace
the original session. A possibly successful timed-out launch is not retried; any
created session is retained and its path shown for recovery with `pi --session`.

Tests:

```sh
node --test ~/.pi/agent/tests/fork-pane.test.mjs
```

Unit tests cover detection, targeting, quoting, independent session persistence,
first-message forks, prefilling and failure cancellation. Herdr pane creation
was also smoke-tested locally. Rex and Ghostty GUI launches require manual checks
inside those applications; their adapters use the installed CLI/scripting APIs.
