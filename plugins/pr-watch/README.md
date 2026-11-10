# pr-watch

Know what happens to a session's pull request without asking. Every minute, pr-watch checks the
pull request the Claude desktop app shows for the session, and when something happens you get a
macOS banner and a dim note in that session.

- **Approved:** someone other than the author approves it.
- **Ready to merge:** a new commit is approved with every check green while auto-merge is off.
- **Left the merge queue:** it drops out of the queue without merging.
- **Merged** or **closed** without merging.
- **Deployed** or **deploy failed:** after the merge, each deploy stage (dev, qa, prod) as its
  deploy run succeeds, or fails with no retry running.

Each event is reported once. Nothing is sent in your name and no reply starts: the banner comes
from session-banners' helper app (a click opens the session), and the note is one Claude does not
read. With `tellClaude` on, Claude also reads the event along with your next message.

The pull request is the one the app shows for the session, or the current branch's pull request
when the app shows none.

## Requirements

- The [GitHub CLI](https://cli.github.com) (`gh`), signed in
- [session-banners](../session-banners), for the banners; without it you get the notes only

## Install

```bash
claude plugin marketplace add IgorKrupenja/claude-plugins
claude plugin install pr-watch@igor-plugins
```

## Settings

Set them with `/plugin configure pr-watch@igor-plugins` in Claude Code, or pipe a JSON object to
`claude plugin configure pr-watch@igor-plugins --values-stdin`.

- `stages`: the branches a merged pull request moves through, in order, as `branch=label` pairs,
  such as `main=dev, qa=qa, prod=prod`. Empty, the default, skips the deploy events.
- `deployWorkflow`: the workflow whose push runs on each stage branch deploy it, `deploy.yml` by
  default.
- `bannerApp`: the session-banners helper app,
  `~/.claude/plugins/data/session-banners-igor-plugins/Claude Notify.app` by default.
- `tellClaude`: also leave each event where Claude reads it with your next message, off by default.

## Develop

```bash
claude plugin validate plugins/pr-watch
claude plugin test plugins/pr-watch
```
