# Local Pi setup notes

## ask_user_question / Herdr

`@juicesharp/rpiv-ask-user-question` was removed at the user's request after
investigating its Herdr status integration. No Pi core patch or plugin fork is
installed.

Investigated versions: Pi 1.4.0, herdr-core 0.1.17, questionnaire plugin 2.15.0.
The reported reproduction showed a visible questionnaire with status `working`,
`hc wait` timing out, and `hc keys ... down enter` successfully choosing an answer
before the agent reached `done`.

Source diagnosis:

- The plugin's `mountQuestionnaire()` uses `ctx.ui.custom()` (normally inline,
  with overlay fallback).
- Pi's `showExtensionCustom()` calls `pushExtensionDialog(c)` without blocked
  metadata; its overlay branch also does not update `ProgramStatusReporter`.
- Pi's native select/input/editor dialogs do supply blocked metadata.
- `ctx.ui.setStatus()` changes footer text, not OSC 7501 status. Writing OSC
  independently would bypass Pi's state tracking and deduplication.

The user declined core changes, then chose removal rather than the plugin's
simpler native-dialog fallback or a custom status workaround.

Removal used `pi remove npm:@juicesharp/rpiv-ask-user-question` (exit 0).
Verified: absent from `pi list`, personal settings, the managed npm dependency
manifest and its installed package directory. Other configured packages remained.
The npm command also reported changing 213 packages in the ignored managed
installation tree; runtime regression testing of those dependencies was not done.

Already-running sessions may retain the loaded extension until the user runs
`/reload` or restarts Pi. No existing session was reloaded, no extra agent was
started, and Herdr/core was not restarted. The removal command ran in its own
short-lived terminal, which was removed afterward.

No repaired `blocked`/answer/cancel lifecycle is claimed: removal superseded the
repair and its proposed interactive tests. The questionnaire entry had never
been committed, so removing it creates no net settings change against HEAD;
pre-existing web/todo settings and model-thinking edits are left uncommitted.
