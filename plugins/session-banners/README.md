# session-banners

Never miss a finished Claude session. When a session in the Claude desktop app finishes, a macOS
banner tells you, and one click takes you straight back to it.

<img src="images/banner.png" width="349" alt="A banner with the session title over the first line of Claude's reply">

- **Jump right back in:** clicking the banner opens the exact session that finished, however many
  you have running.
- **See what happened at a glance:** the banner shows the session's title and the first line of
  Claude's reply.
- **Only when you're away:** while you're working in the Claude app, it stays quiet.

## Requirements

- macOS and the [Claude desktop app](https://claude.com/download)
- Xcode Command Line Tools (`xcode-select --install`), to build the small helper app that posts
  the banners

## Install

```bash
claude plugin marketplace add IgorKrupenja/claude-plugins
claude plugin install session-banners@igor-plugins
```

Or run `/plugin marketplace add IgorKrupenja/claude-plugins` and then
`/plugin install session-banners@igor-plugins` in a Claude Code session.

The next session builds the helper app, Claude Notify, which takes about 15 seconds once. The
first banner asks you to allow notifications from Claude Notify. To keep banners on screen until
you dismiss them, set Claude Notify to Persistent in System Settings > Notifications.

## How it works

- A `SessionStart` hook builds `Claude Notify.app` from [`helper/`](helper) into the plugin's data
  folder, `~/.claude/plugins/data/session-banners-igor-plugins/`, and rebuilds it when its
  sources change.
- A `Stop` hook, [`stop-hook.py`](scripts/stop-hook.py), launches the helper with the banner text
  and the session's `claude://` link. When a turn ends with a question, it leaves the banner to
  the app, which shows its own for those.
- Other plugins post through the same helper: [pr-watch](../pr-watch) passes a seventh argument,
  its own banner ID, so its banners sit beside the session's instead of replacing them.

## Uninstall

```bash
claude plugin uninstall session-banners@igor-plugins
```
