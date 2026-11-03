# Personal fork

This private local Pi package is based on upstream `pi-codex-image-gen` 0.3.0
(commit `91fd55fdfd7c5516ac8d08267f34b49f1b37d050`). It adds the explicit
`background` parameter, transparent PNG/WebP validation and related tests and
skill guidance. The original Apache-2.0 license and attribution are retained.

The package name is `pi-codex-image-gen-local` to identify this fork; its tool,
skill and OAuth provider names remain unchanged for compatibility. Configure
only this fork, not the public npm package. The dotfiles Git commit pins its
source, and `package-lock.json` pins its dependencies. Install local runtime
dependencies with `npm ci --omit=dev --omit=peer --ignore-scripts`, manually or
through the Mac playbook.

The upstream README is retained for attribution and feature documentation; use
`.pi/README.md` at the dotfiles root for this fork's installation instructions.
