# claude-plugins

CAVI's Claude Code plugin marketplace. Add it once and install any of the plugins below.

```
/plugin marketplace add cavi-ai/claude-plugins
/plugin install <plugin-name>@claude-plugins
```

## Plugins

| Plugin | What it does | Source |
| --- | --- | --- |
| **claude-obsidian** | Cowork with Claude inside your Obsidian vault — synthesize and link notes, keep tags clean, draft from outlines, capture sessions as knowledge, build self-contained HTML artifacts, drive spec-based builds, and get `manifest-*` advisor roadmaps, all over the Companion for Claude MCP bridge. | [`cavi-ai/claude-obsidian-plugin`](https://github.com/cavi-ai/claude-obsidian-plugin) |

## How this catalog works

This repo is a **catalog**, not a container. Each entry in
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) points at wherever the
plugin actually lives:

- **Standalone plugins** live as subdirectories in this repo (relative-path `source`).
- **Paired plugins** — shipped alongside another product (e.g. `claude-obsidian`, which pairs
  with the Companion for Claude Obsidian plugin over an MCP bridge) — keep their own repo and
  are referenced here via a `github` source. Each plugin's own `plugin.json` still governs its
  version and components.

Adding a plugin to the catalog never moves its code — it just makes it discoverable from one
`/plugin marketplace add`.
