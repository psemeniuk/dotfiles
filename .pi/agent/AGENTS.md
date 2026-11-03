# Pi setup

- `~/.pi/agent` links to `~/development/private/dotfiles/.pi/agent`; changes to versioned Pi configuration or local extensions modify that repository.
- At task end, review new and ignored Pi paths by name; allowlist relevant non-secret setup files and commit only relevant changes. Never commit credentials, sessions or caches; ask the user before pushing.
