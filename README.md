# Claude plugins

Claude Code plugins for the [Claude desktop app](https://claude.com/download). Not affiliated with
Anthropic.

| Plugin | What it does |
| --- | --- |
| [session-banners](plugins/session-banners) | A macOS banner when a session finishes. One click opens that session. |
| [linear-link](plugins/linear-link) | The session's Linear ticket as a link above the message box, next to the pull request the app already shows. |

## Install

Add the marketplace once, then install the plugins you want:

```bash
claude plugin marketplace add IgorKrupenja/claude-notify
claude plugin install session-banners@igor-plugins
claude plugin install linear-link@igor-plugins
```

Or run `/plugin marketplace add IgorKrupenja/claude-notify` and then
`/plugin install <plugin>@igor-plugins` in a Claude Code session. Each plugin's README covers its
requirements and settings.

## Update

```bash
claude plugin marketplace update igor-plugins
```
