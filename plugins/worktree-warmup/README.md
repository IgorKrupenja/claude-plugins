# worktree-warmup

A new git worktree starts with no dependencies, so the first test run, push or `scripts/stack up`
waits on an install. This plugin starts that install the moment a session opens in a new
worktree, in the background, and shows its progress above the message box.

- **Ready before you need it:** in a worktree that has `pnpm-lock.yaml` and no current install
  (no `node_modules`, one older than the lockfile, or a generated file missing, as a reused
  worktree often has), it runs the setup command from the worktree's root, under the node
  version `.nvmrc` names when nvm is installed, so that version needs its own `pnpm`.
- **Progress where you look:** `Setting up this worktree` with pnpm's latest line while it runs,
  `Worktree ready in 38s` for half a minute when it is done, and `Worktree setup failed` with the
  last line and a Retry button when it is not. The full output lands in the worktree's git
  folder, `.git/worktrees/<name>/worktree-warmup.log`.
- **No races:** while it runs, a command of Claude's that needs the dependencies (`pnpm`, `node`,
  `tsc`, `vitest`, `turbo`, `scripts/stack`, ...) waits for the setup to finish before it starts.
- **Shares the row:** whatever other plugins show above the message box, such as status-bar,
  stays there below its line.

## Install

```bash
claude plugin marketplace add IgorKrupenja/claude-plugins
claude plugin install worktree-warmup@igor-plugins
```

## Settings

Set them with `/plugin configure worktree-warmup@igor-plugins` in Claude Code, or pipe a JSON
object to `claude plugin configure worktree-warmup@igor-plugins --values-stdin`.

- `command`: what runs in a new worktree, `pnpm install --frozen-lockfile` by default. A repository
  that generates files after the install chains them, such as
  `pnpm install --frozen-lockfile && pnpm run media:manifest`.
- `trigger`: the setup runs only in a worktree that has this file at its root,
  `pnpm-lock.yaml` by default, and again whenever the file is newer than the install.
- `installed`: the file an install writes, whose age is compared with the trigger file,
  `node_modules/.modules.yaml` by default.
- `requires`: comma-separated paths a ready worktree also has, such as files the setup command
  generates (`packages/shared/src/mediaRegistry.generated.ts`). One missing runs the setup.

## Develop

```bash
claude plugin validate plugins/worktree-warmup
claude plugin test plugins/worktree-warmup
```
