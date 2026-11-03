# Pi configuration

The user-level Pi directory is linked here: `~/.pi/agent -> dotfiles/.pi/agent`.
Pi and Node are installed with Homebrew; no custom Pi launcher is required.

The two local packages are listed in `agent/settings.json`. The standalone
`agent/extensions/per-model-thinking.ts` is discovered automatically by Pi.
The dotfiles commit pins local source; the image package's `package-lock.json`
pins its npm dependencies. Pi automatically installs missing npm/Git packages,
but does not install dependencies of packages loaded from local paths.

The Mac playbook links the agent directory and runs `npm ci` for local packages
that have a lockfile. It runs `npm ci` on each provisioning run, not on each Pi
startup. To install a local package's dependencies manually:

```sh
cd ~/.pi/agent/packages/pi-codex-image-gen-local
npm ci --omit=dev --omit=peer --ignore-scripts
```

The playbook refuses to replace an existing agent directory or a link to a
different location; back up and migrate those files manually. It does not manage
or copy OAuth credentials. Node and Pi come from Homebrew, so their versions
are not pinned for fresh installs by this repository.

## Secrets and Git

Credentials and sessions physically live in the linked directory. `.gitignore`
ignores runtime data by default and permits selected configuration and source;
new top-level plugin files need review before allowing them. The pre-commit
configuration rejects staged files matching Git ignore rules and runs Gitleaks
across the repository. These checks can be bypassed and cannot detect every
secret: do not put literal keys
in settings, and review staged changes.

The playbook also installs the pre-commit hook and a local Git exclude that
protects agent data on branches without this configuration. The hook refuses
commits containing Pi agent files when the branch has no pre-commit config.
If an unrelated hook already exists, the playbook refuses to overwrite it.

Until these files are on `master`, switching dotfiles to `master` can make Pi's
linked configuration disappear. The local Git protections remain in place, but
Pi itself may not work until this branch is checked out again.
