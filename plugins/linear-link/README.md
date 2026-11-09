# linear-link

The Claude desktop app shows each session's pull request. This plugin adds the session's Linear
ticket and its designs: a `Linear LIQ-123 · Figma` row of links above the message box, in every
session that works on a ticket.

- **Read from what you already write:** the ticket IDs come from the title of the pull request
  the app shows for the session (`feat(api): LIQ-123: ...`, several IDs work too), then the
  current branch's pull request, then the branch name (`liq-123-...`) before any pull request
  exists. A worktree on a detached HEAD still gets its link from the session's pull request.
- **The design one click away:** with a Linear API key, every Figma frame the ticket links, in
  its description or as an attachment, gets its own `Figma` link next to the ticket.
- **The exact ticket page:** the link is the Linear URL the pull request body carries, the
  ticket's own URL from Linear, or `linear.app/<workspace>/issue/<id>`.
- **Keeps up by itself:** it checks again after every turn, so a new branch or a new pull request
  shows up without a restart.

## Requirements

- `git` and the [GitHub CLI](https://cli.github.com) (`gh`), signed in, to read the pull request
- A session started in a git checkout, such as a worktree session

## Install

```bash
claude plugin marketplace add IgorKrupenja/claude-plugins
claude plugin install linear-link@igor-plugins
```

## Settings

Both are optional. Set them with `/plugin configure linear-link@igor-plugins` in Claude Code, or
pipe a JSON object to `claude plugin configure linear-link@igor-plugins --values-stdin`.

- `linearApiKey`: a personal API key from Linear (Settings > Security & access), for the Figma
  links and each ticket's exact URL. It is kept in secure storage, never in `settings.json`.
  Without it the plugin also reads a `LINEAR_API_KEY` environment variable.
- `workspace`: your Linear workspace's URL key, the `acme` in `linear.app/acme/issue/ACME-1`, for
  a branch that has no pull request yet when no API key is set.

## Develop

```bash
claude plugin validate plugins/linear-link
claude plugin test plugins/linear-link
```
