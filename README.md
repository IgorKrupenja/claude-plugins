# Claude plugins

Claude Code plugins for the [Claude desktop app](https://claude.com/download). Not affiliated with
Anthropic.

| Plugin | What it does |
| --- | --- |
| [session-banners](plugins/session-banners) | A macOS banner when a session finishes; one click opens that session. Its helper app also shows pr-watch's banners. |
| [status-bar](plugins/status-bar) | A row above the message box: the session's Linear ticket with its state and Figma frames, the pull request's preview links, and how far the merged change has deployed. |
| [pr-watch](plugins/pr-watch) | A macOS banner and a note in the session when the session's pull request is approved, turns ready to merge, leaves the merge queue, merges, closes, or deploys or fails to deploy. Never a message in your name. |
| [worktree-warmup](plugins/worktree-warmup) | Installs a new or stale worktree's dependencies in the background when its session starts, with progress above the message box. Claude's commands that need them wait. |

## Install

Add the marketplace once, then install the plugins you want:

```bash
claude plugin marketplace add IgorKrupenja/claude-plugins
claude plugin install session-banners@igor-plugins
claude plugin install status-bar@igor-plugins
claude plugin install pr-watch@igor-plugins
claude plugin install worktree-warmup@igor-plugins
```

Or run `/plugin marketplace add IgorKrupenja/claude-plugins` and then
`/plugin install <plugin>@igor-plugins` in a Claude Code session. Each plugin's README covers its
requirements and settings.

## Update

```bash
claude plugin marketplace update igor-plugins
```
