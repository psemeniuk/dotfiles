# fast (local fork)

This is a local fork of `@diegopetrucci/pi-fast` 0.1.11. It remembers ordinary Fast
mode independently for each exact provider/model across sessions and adds Codex
GPT-6.1 Terra. Pi loads this local copy rather than the npm package, so npm
updates will not overwrite the changes. The upstream project is MIT licensed.

A pi extension that provides `/fast` and `/ultrafast` toggles for supported direct OpenAI API, OpenAI Codex, and Anthropic Claude models. It selects the provider-specific Fast-mode request shape from the currently selected model.

For eligible direct OpenAI API-key models it injects:

```json
{
  "service_tier": "fast"
}
```

For eligible direct OpenAI ChatGPT OAuth models it injects:

```json
{
  "service_tier": "priority"
}
```

For eligible OpenAI Codex OAuth models it injects:

```json
{
  "service_tier": "priority"
}
```

For eligible Anthropic Claude models it injects:

```json
{
  "speed": "fast"
}
```

It also appends the required beta `fast-mode-2026-02-01` to the request's `betas` list, which Pi sends as the `anthropic-beta` header. The extension does not set the `anthropic-beta` header itself, so Pi's own betas are kept.

## Eligibility

Direct OpenAI API Fast mode requires all of the following:

- Provider `openai`.
- API `openai-responses` or `openai-completions`.
- Model `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, or `gpt-6-luna`.
- API-key auth sets `service_tier: "fast"`; Pi's `openai` ChatGPT OAuth sets `priority`.
- No existing `service_tier` field in the request payload.

The direct OpenAI route stays on OpenAI's direct API contract but selects the tier by auth
type. OAuth uses `priority` because its endpoint rejected `fast`; acceptance or application
of `priority` on Pi's OAuth endpoint has not been live-verified. This direct route is never
forwarded to legacy `openai-codex` or its subscription-usage endpoint. The request shape is
support evidence, not certification; tests use mocked eligibility and payloads only, with
no live or paid provider calls.

### Ultrafast support (initial, fail-closed)

Ultrafast is intentionally narrower than ordinary Fast mode. It requires all of
the following on every activation and provider request:

- Provider `openai`.
- API `openai-responses`.
- Model `gpt-6-astra`.
- Direct API-key auth, not Codex OAuth or direct OpenAI OAuth.
- Base URL exactly `https://api.openai.com/v1` (a single trailing slash is also accepted).

It does not support Chat Completions, preview models, regional or proxy endpoints,
or Anthropic Ultrafast. Eligible payloads receive the requested
`service_tier: "ultrafast"` only when they do not already contain a
`service_tier` field. Existing values and mismatched/malformed payloads are left
untouched. The extension reports a requested tier; it does not claim that OpenAI
accepted or applied it, and it never silently falls back to ordinary Fast.

OpenAI documents this request shape in the [Ultrafast API guide](https://developers.openai.com/api/docs/guides/ultrafast-mode)
and lists the account/model pricing in its [API pricing](https://developers.openai.com/api/docs/pricing).
Actual Ultrafast API pricing is **6x Standard**, while Pi's current cost display
omits that premium. Treat the activation warning as a deliberate paid-usage
warning.

OpenAI Codex Fast mode requires all of the following:

- Provider `openai-codex`.
- API `openai-codex-responses`.
- Model `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-sol`, or `gpt-6-luna`.
- The installed Codex model catalog advertises `priority` as Fast for `gpt-6.1-terra`; actual availability and application depend on the account and service.
- ChatGPT OAuth/subscription auth, not API-key auth.
- No existing `service_tier` field in the request payload.

Codex evidence, 2026-10-03: the [maintainer's PR #103 review](https://github.com/diegopetrucci/pi-extensions/pull/103)
reports that the Codex model list advertises Fast as `priority` for `gpt-6-astra`,
`gpt-6.1-sol`, `gpt-6-sol`, and `gpt-6-luna`. The official Codex CLI
[sends Fast as `priority`](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/config_types.rs#L539-L553).
The maintainer's live check through Pi 1.0.0 on that date returned HTTP 200 and
completed normally for `gpt-6-astra` and `gpt-6.1-sol`; `gpt-6-sol` and
`gpt-6-luna` are enabled based on the model list only. In that check,
`response.completed` always reported `service_tier: "default"`, with or without
`priority`, so the response cannot confirm Fast was applied.

Pi's displayed cost may not reflect the requested Fast tier: this extension
modifies the serialized request, and the server may report `service_tier:
"default"` even after `priority` was requested. It does not measure included
subscription allowance consumption or confirm Fast was applied. [OpenAI's Codex
speed documentation](https://developers.openai.com/codex/speed), checked on
2026-10-03, describes higher consumption for Fast; availability and current
rates depend on the model, account, and billing plan.

Anthropic Fast mode requires all of the following:

- Provider `anthropic`.
- API `anthropic-messages`.
- Model `claude-opus-4-8`, `claude-opus-5`, or `claude-opus-5-5`.
- No existing `speed` field in the request payload.

Anthropic Fast mode supports both API-key and Claude Code OAuth access when the account has access to the research preview.

## Commands

```text
/fast
/ultrafast
/fast ultrafast
```

Run `/fast` to toggle ordinary Fast mode for the currently selected model. The
choice is saved per exact provider/model and restored when switching models,
starting a new session, or restarting Pi. A model with no saved choice uses the
config default (off by default). Unsupported models cannot be enabled; if a
previously enabled model becomes ineligible, `/fast` can still turn it off. The
footer shows `fast` only while the selected model is eligible and enabled; for
`gpt-6-astra`, the label has a red background.
Preferences are stored as separate atomic files under
`~/<pi-config-dir>/agent/per-model-fast/`, so different models do not overwrite
one another when multiple Pi processes are running. The old
`extensions/pi-openai-fast.json` belongs to a deprecated plugin and is not read
or migrated; models start with the config default until explicitly toggled.

`/ultrafast` and `/fast ultrafast` are equivalent toggles for the session-only
Ultrafast override. Ultrafast defaults off, is never enabled by global or project
configuration, and can be undone with either command. Enabling Ultrafast saves
ordinary Fast as off for that model, so disabling Ultrafast does not silently
switch to another paid tier. Running ordinary `/fast` while Ultrafast is selected
turns Ultrafast off. Switching to an unsupported model or endpoint disables
Ultrafast and does not re-enable it when `gpt-6-astra` is selected again; other
models retain their own Fast preferences. The
footer uses `ultrafast` while an eligible request is selected; status text says
that the tier is requested, not remotely applied.

The extension defaults to off so installing the full collection does not accidentally spend Fast-mode credits. Ultrafast verification is mocked-only: tests use local eligibility checks, fake payloads, and a fake fetch through Pi's `openai-responses` `streamSimple`; they make no live or paid provider requests.

## Config

Optional global config:

```text
~/<pi-config-dir>/agent/extensions/fast.json
```

Optional project config, from the nearest ancestor of the working directory (the working directory itself counts):

```text
<project>/<pi-config-dir>/fast.json
```

Here `<pi-config-dir>` is Pi's runtime config directory name (`CONFIG_DIR_NAME`; `.pi` by default). The loader uses that nearest ancestor `fast.json`, which overrides global config after Pi reports that the project is trusted.

```json
{
  "enabled": false,
  "showStatus": true
}
```

- `enabled`: default Fast-mode state when there is no saved preference for this model.
- `showStatus`: show a compact `fast` status when Fast mode is active for the selected model.

The unified extension reads only `fast.json`. It does not read `openai-fast.json` or `claude-fast.json`.

## Install

This machine uses `./pi-fast-local` in agent `settings.json`. The commands below
install upstream, which does not contain this fork's per-model changes.

### Standalone npm package

```bash
pi install npm:@diegopetrucci/pi-fast
```

### Collection package

```bash
pi install npm:@diegopetrucci/pi-extensions
```

### GitHub package

```bash
pi install git:github.com/diegopetrucci/pi-extensions
```

Then reload pi:

```text
/reload
```

## Legacy provider-specific packages

The collection package loads this unified extension only (`extensions/fast/index.ts`). `openai-fast` and `claude-fast` remain published as deprecated standalone leftovers. On session start they warn, clear their leftover footer status, and remove `fast-mode-2026-02-01` from the current model header. They do not read config, register commands, or inject Fast fields into requests.

## Local tests

Run `python3 tests/test_fast.py -v` from this directory. These tests use isolated
Pi agent directories, fake credentials, and loopback HTTP/WebSocket servers; they
do not contact model providers.

## Notes

- Anthropic Fast mode has separate rate limits, costs more than standard speed, and does not share prompt-cache prefixes with standard-speed requests.
- Direct OpenAI Fast mode is limited to the confirmed GPT-6 API models above; Fast pricing, availability, and rate limits remain provider- and account-dependent.
- Authoritative support evidence: [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) explicitly uses `gpt-6.1-sol` with `service_tier: "fast"` and documents `priority` as an equivalent alias for supported API models; the [GPT-6.1 Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) documents the model itself.
- Codex Fast availability depends on plan, client, workspace settings, and rollout. Local eligibility is not live-provider certification.
- Pi's provider catalog remains the source of reported model pricing, including any tiered pricing; this extension does not apply guessed discounts or rewrite cost metadata.
- OpenAI Codex Fast mode intentionally does not affect API-key models.
- Deprecated `openai-fast` and `claude-fast` packages no longer implement Fast mode. New provider/auth behavior belongs only to this unified extension.
- Existing `speed` and `service_tier` fields are never overwritten.
- Pi's model catalog may not include a Fast-mode premium. Cost accounting depends on the provider reporting the effective tier in its streamed response, and this extension does not patch usage totals.
