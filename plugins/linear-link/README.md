# linear-link

The Claude desktop app shows each session's pull request. This plugin adds the session's Linear
ticket: a `Linear LIQ-123` link in a slim row above the message box, in every session that works
on a ticket.

- **Read from what you already write:** the ticket IDs come from the pull request title
  (`feat(api): LIQ-123: ...`, several IDs work too), or from the branch name (`liq-123-...`)
  before the pull request exists.
- **The exact ticket page:** the link is the Linear URL the pull request body carries, or
  `linear.app/<workspace>/issue/<id>` when it has none.
- **Keeps up by itself:** it checks again after every turn, so a new branch or a new pull request
  shows up without a restart.

## Requirements

- `git` and the [GitHub CLI](https://cli.github.com) (`gh`), signed in, to read the pull request
- A session started in a git checkout, such as a worktree session

## Install

```bash
claude plugin marketplace add IgorKrupenja/claude-notify
claude plugin install linear-link@igor-plugins
```

## Settings

`workspace` is your Linear workspace's URL key, the `acme` in `linear.app/acme/issue/ACME-1`. The
plugin needs it only for a branch that has no pull request yet; without it that ticket shows as
plain text. Set it in `~/.claude/settings.json`:

```json
"pluginConfigs": {
  "linear-link@igor-plugins": { "options": { "workspace": "acme" } }
}
```

## Develop

```bash
claude plugin validate plugins/linear-link
claude plugin test plugins/linear-link
```
