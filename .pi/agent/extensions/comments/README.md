# Response comments

Local Pi extension using public extension/TUI APIs only. No core patches or additional dependencies. Tested with Pi 1.4.0. Load with `/reload` (or restart Pi).

## Workflow

1. Run `/comments` while the agent is idle. The overlay opens the latest assistant response as **source Markdown**, not rendered Markdown.
2. Use `[` / `]` to switch responses on the active session branch.
3. Drag across text with the mouse (fullscreen mode). Releasing opens a small comment editor.
4. Enter saves; Shift+Enter inserts a newline; Escape cancels. Saved drafts get a background highlight and a short ID (`c1`, `c2`, …) in the margin.
5. Click a highlighted passage to edit its draft. Ctrl+D in the draft editor deletes it. Overlapping comments are allowed; Tab cycles through them, Enter opens the selected one. A `+` in the margin indicates multiple comments on that row.
6. Escape closes the main overlay. `/submit-comments` sends **all draft comments across responses** as an ordinary user message and locks them against editing/deletion.
7. The agent answers in the ordinary chat. Open `/comments`, navigate back to the annotated response, and click the passage to see its comment and answer together.

Keyboard alternative: arrows move the text cursor; Space toggles a selection anchor, then arrows extend it; Shift+arrows also start/extend a selection; Enter opens the comment editor. PageUp/PageDown and the mouse wheel scroll. In read-only answers, arrows/PageUp/PageDown/wheel scroll and Escape closes.

Comments are highlighted only in this overlay, not in Pi's main transcript. Text wrapping is grapheme-based (long lines wrap at the viewport edge). For long mouse selections, drag beyond the upper/lower content edge to scroll on further drag events, or use wheel/keyboard scrolling. There is no timed edge-autoscroll.

## Storage and answer binding

- Versioned `response-comments-v1` custom entries in the existing session store immutable snapshots of drafts, source message IDs, UTF-16 text ranges, exact quotes, submission batches, and answers. No external storage; metadata is excluded from model context.
- State is reconstructed from the **active branch**, including `/tree` navigation. IDs are allocated against all entries of the session to avoid reusing IDs from deleted drafts or abandoned branches.
- Prompts expose only short comment IDs and quoted text, not internal message IDs or offsets. The instruction is fixed English text, requiring answers in each comment's language and no tools or changes.
- During a comment-answer run, the extension blocks all agent tool calls. Normal turns are unaffected. This is a Pi-level tool gate, not an OS sandbox or protection against unrelated extensions.
- Replies are associated with the exact submission's user turn and parsed using `## Comment c1` headings. Headings inside code fences do not count. Empty or duplicate sections are not assigned.
- If a completed response has no unambiguous matching section, the comment viewer explicitly labels and shows the full response as a fallback. Interrupted/error responses are not treated as completed answers; the submitted comment remains read-only.
- Persisted answers are refreshed after agent runs. On reload, answers can also be recovered from the original user/assistant messages if a final metadata snapshot was not written.

## Tests

```sh
node --test ~/.pi/agent/tests/comments.test.mjs
```

The runner locates the Homebrew Pi package through `pi` on PATH. For a different installation, set `PI_PACKAGE` to the installed `@earendil-works/pi-coding-agent` directory.

Tests cover persistence/branching, deterministic prompts, answer parsing and turn boundaries, interrupted responses, Unicode/resize, mouse and keyboard selection, editor focus, actual Pi extension loading, fullscreen SGR mouse dispatch with stacked overlays, submission and the tool gate. They do not make network/model calls.
