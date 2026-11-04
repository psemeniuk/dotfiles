# Response comments

Local Pi extension using public extension/TUI APIs only. No core patches. Tested with Pi 1.4.0. Install its source-alignment dependency with `npm ci --prefix ~/.pi/agent/extensions/comments`, then load with `/reload` (or restart Pi).

## Workflow

1. Run `/comments` while the agent is idle. The subtly bordered overlay opens the latest assistant response using the same **Markdown renderer and theme as the main chat** (headings, emphasis, links, lists, tables and highlighted code).
2. Use `[` / `]` to switch responses on the active session branch.
3. Drag across text with the mouse (fullscreen mode). Releasing opens a small comment editor.
4. Enter saves; Shift+Enter inserts a newline; Escape cancels the edit. Saved drafts get a background highlight and a short ID (`c1`, `c2`, …) in the margin.
5. Click a highlighted passage to edit its draft. Ctrl+D in the draft editor deletes it. Overlapping comments are allowed; Tab cycles through them, Enter opens the selected one. A `+` in the margin indicates multiple comments on that row.
6. Escape closes the main overlay. `/submit-comments` sends **all draft comments across responses** as an ordinary user message and locks them against editing/deletion.
7. Each answer in the chat is requested to repeat its passage and your comment directly below `## Comment cN`, followed by the answer. You can match passage → question → answer without jumping between messages.
8. **Any new completed text answer clears all active comments**, including unsent drafts. The footer status and highlights disappear. The chat history remains; comments are not a permanent annotation archive.

Use `/cancel-comments` while idle, after closing the overlay, to discard all active comments without sending anything. This does not remove messages from the chat or abort an agent run.

`/submit-comments` is suggested only when drafts exist; `/cancel-comments` is suggested only when active comments exist. Pi has no public unregister-command API, so both handlers remain registered and safely report an empty state if entered manually. Visibility is controlled with the public autocomplete-provider wrapper, not a core patch.

Keyboard alternative: arrows move the text cursor; Space toggles a selection anchor, then arrows extend it; Shift+arrows also start/extend a selection; Enter opens the comment editor. PageUp/PageDown and the mouse wheel scroll.

Comments are highlighted only in this overlay, not in Pi's main transcript. Wrapping follows Pi's Markdown renderer. Selection uses grapheme display widths and aligns rendered text with UTF-16 source offsets, preserving exact source quotes. Renderer-inserted decorations have no selectable source range; transformed text (such as LaTeX) may not have a direct source match. Source alignment is bounded to one second; if it exceeds that budget the response remains readable but cannot be selected. For long mouse selections, drag beyond the upper/lower content edge to scroll on further drag events, or use wheel/keyboard scrolling. There is no timed edge-autoscroll.

## Storage and lifecycle

- Versioned `response-comments-v1` custom entries in the existing session store snapshots of active drafts, source message IDs, UTF-16 text ranges, exact quotes and submission batches. No external storage; metadata is excluded from model context.
- State is reconstructed from the **active branch**, including `/tree` navigation. IDs are allocated against all entries of the session to avoid reusing IDs from cancelled/deleted drafts or abandoned branches.
- Reset/cancellation is persisted as an empty snapshot. Reconstruction also clears state when it encounters a completed assistant text response after a snapshot, covering process exit before the reset hook ran. Reload does not resurrect cleared comments. Navigating to a historical branch *before* a reset restores that historical state.
- Reset happens after a completed text response (`stopReason: stop`), whether it answers comments or an unrelated prompt. Tool-only, interrupted, error and truncated responses do not trigger reset.
- Prompts expose only short comment IDs and quoted text, not internal message IDs or offsets. The fixed English instruction requires answers and quoted-field labels in each comment's language, repeated passage/comment context, and no tools or changes.
- During a comment-answer run, the extension blocks all agent tool calls. Normal turns are unaffected. This is a Pi-level tool gate, not an OS sandbox or protection against unrelated extensions.
- Submitted comments are read-only until reset/cancellation. Interrupted submissions remain inspectable; no completed answer is claimed. Legacy answer metadata remains readable until a new answer clears the state.
- Reset clears the active view, not historical metadata entries in the append-only session file.

## Tests

```sh
node --test ~/.pi/agent/tests/comments.test.mjs
```

The runner locates the Homebrew Pi package through `pi` on PATH. For a different installation, set `PI_PACKAGE` to the installed `@earendil-works/pi-coding-agent` directory.

Tests cover persistence/branching/reset/cancellation, dynamic command suggestions, deterministic prompts, answer parsing, interrupted responses, Unicode/resize, mouse and keyboard selection, editor focus, actual Pi extension loading, fullscreen SGR mouse dispatch with stacked overlays, submission and the tool gate. They do not make network/model calls.
