# CAVI plugins for agent hosts

`cavi-ai/plugins` is CAVI's host-neutral discovery catalog for installable agent extensions. Plugin source stays in each plugin's own repository; this repository publishes one canonical catalog and validated host projections.

## Plugins

| Plugin | Claude | Codex | Gemini | OpenCode | AgentSkills |
| --- | :---: | :---: | :---: | :---: | :---: |
| [`mlx-agent`](https://github.com/cavi-ai/mlx-agent) — discover, verify, and wire local MLX models | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`obsidian-agent`](https://github.com/cavi-ai/obsidian-agent) — portable vault workflows over the official Obsidian CLI | ✓ | ✓ | ✓ | ✓ | ✓ |

The machine-readable source of truth is [`catalog.json`](catalog.json). Claude and Codex consume native marketplace projections. Gemini and OpenCode use the discovery records under `providers/`, which link to each source repository's tested installer; those files do not claim a native marketplace protocol. Portable AgentSkills packages remain available from each plugin repository.

## Claude Code

Add the marketplace, then install either plugin:

```text
/plugin marketplace add cavi-ai/plugins
/plugin install mlx-agent@cavi-ai
/plugin install obsidian-agent@cavi-ai
```

## Codex

Add the marketplace, then install either plugin:

```sh
codex plugin marketplace add cavi-ai/plugins
codex plugin add mlx-agent@cavi-ai
codex plugin add obsidian-agent@cavi-ai
```

The Codex projection at [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) uses Codex's documented marketplace-local source layout. `packages/codex/` contains minimal, self-contained projections copied from exact upstream commits. Each package includes provenance and a deterministic tree hash; catalog validation rejects local drift.

These package projections are distribution artifacts, not independent workflow sources. Refresh one only from a reviewed upstream commit, update its `provenance.json`, and run the full catalog gate. Product development remains in the linked plugin repository.

## Gemini CLI

Gemini discovery metadata is in [`providers/gemini/catalog.json`](providers/gemini/catalog.json). Each entry records the source repository's native installation command. For example:

```sh
git clone https://github.com/cavi-ai/mlx-agent.git
gemini extensions install ./mlx-agent/providers/gemini

gemini extensions install https://github.com/cavi-ai/obsidian-agent
```

Both commands use Gemini's native extension loader. The discovery catalog itself does not install anything.

## OpenCode

OpenCode discovery metadata is in [`providers/opencode/catalog.json`](providers/opencode/catalog.json). Both source repositories provide preview-first installers:

```sh
git clone https://github.com/cavi-ai/mlx-agent.git
python3 mlx-agent/scripts/mlx-agent install opencode --scope user --dry-run --json

git clone https://github.com/cavi-ai/obsidian-agent.git
node obsidian-agent/scripts/install.mjs --host opencode --scope user --dry-run
```

Review the destination paths and use the exact preview hash when confirming.

## AgentSkills

Both plugins publish portable skills under their AgentSkills adapter. Follow the selected repository's project- or user-scope installation instructions; the catalog does not copy or fork skill content.

## Validate the catalog

Node.js 22 or newer is sufficient:

```sh
node --test
node scripts/validate-catalog.mjs
```

Validation rejects identity drift, unknown or missing hosts, duplicate entries, non-plugin products, and projections that disagree with the canonical repository or package path.
