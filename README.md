# CAVI plugins for agent hosts

`cavi-ai/plugins` is CAVI's host-neutral discovery catalog for installable agent extensions. Plugin source stays in each plugin's own repository; this repository publishes one canonical catalog and validated host projections.

## Plugins

| Plugin | Claude | Codex | Agy | OpenCode | OpenClaw | Hermes | AgentSkills |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| [`mlx-agent`](https://github.com/cavi-ai/mlx-agent) — discover, verify, and wire local MLX models | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [`obsidian-agent`](https://github.com/cavi-ai/obsidian-agent) — portable vault workflows over the official Obsidian CLI | ✓ | ✓ | — | ✓ | — | — | ✓ |
| [`loop-killer`](https://github.com/cavi-ai/loop-killer) — end stop-hook re-prompt loops by clearing the active goal | ✓ | — | — | — | — | — | — |

The machine-readable source of truth is [`catalog.json`](catalog.json). Claude and Codex consume native marketplace projections. Agy, OpenCode, OpenClaw, and Hermes use the discovery records under `providers/`, which link to each source repository's tested installer; those files do not claim a native marketplace protocol. Portable AgentSkills packages remain available from each plugin repository.

## Releases

[`releases.json`](releases.json) pins each released plugin to one tag and commit, and every host installs that release: the Claude marketplace source carries the tag as `ref` and the commit as `sha`, each discovery install command clones the tag, and the Codex package is copied from it. `loop-killer` has no release yet, so its Claude source follows the default branch.

A plugin's release workflow sends a `cavi-oss-release` dispatch. [Sync plugin release](.github/workflows/sync-plugin-release.yml) checks out the tag, confirms it resolves to the released commit, points every host at it with `scripts/sync-release.mjs`, runs the catalog gate and opens a pull request. The same workflow runs by hand from the Actions tab with a plugin name and tag. Locally:

```sh
node scripts/sync-release.mjs --name mlx-agent --source <checkout at the tag> --tag <release tag> --commit <full commit>
node --test && node scripts/validate-catalog.mjs
```

## Claude Code

Add the marketplace, then install a plugin:

```text
/plugin marketplace add cavi-ai/plugins
/plugin install mlx-agent@cavi-ai
/plugin install obsidian-agent@cavi-ai
/plugin install loop-killer@cavi-ai
```

## Codex

Add the marketplace, then install either plugin:

```sh
codex plugin marketplace add cavi-ai/plugins
codex plugin add mlx-agent@cavi-ai
codex plugin add obsidian-agent@cavi-ai
```

The Codex projection at [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) uses Codex's documented marketplace-local source layout, so `packages/codex/` holds a self-contained copy of each release's Codex package. These copies are distribution artifacts, not independent workflow sources; product development remains in the linked plugin repository. `packages/codex/expected-integrity.json` pins each copy's release commit, tree hash and skill inventory, `provenance.json` inside the package must agree with it, and validation rejects local drift.

## Agy

Agy discovery metadata is in [`providers/agy/catalog.json`](providers/agy/catalog.json). Each entry records the source repository's native installation command for the pinned release:

```sh
git clone --branch <release tag> --depth 1 https://github.com/cavi-ai/mlx-agent.git
agy plugin install ./mlx-agent/providers/agy
```

The discovery catalog itself does not install anything. `obsidian-agent` does not ship an Agy plugin.

## OpenCode

OpenCode discovery metadata is in [`providers/opencode/catalog.json`](providers/opencode/catalog.json). Both source repositories provide preview-first installers:

```sh
git clone --branch <release tag> --depth 1 https://github.com/cavi-ai/mlx-agent.git
python3 mlx-agent/scripts/mlx-agent install opencode --scope user --dry-run --json

git clone --branch <release tag> --depth 1 https://github.com/cavi-ai/obsidian-agent.git
node obsidian-agent/scripts/install.mjs --host opencode --scope user --dry-run
```

Review the destination paths and use the exact preview hash when confirming.

## OpenClaw and Hermes

OpenClaw and Hermes discovery metadata is in [`providers/openclaw/catalog.json`](providers/openclaw/catalog.json) and [`providers/hermes/catalog.json`](providers/hermes/catalog.json). The `mlx-agent` installer places its skills in `$OPENCLAW_STATE_DIR/skills` or `$HERMES_HOME/skills`:

```sh
git clone --branch <release tag> --depth 1 https://github.com/cavi-ai/mlx-agent.git
python3 mlx-agent/scripts/mlx-agent install openclaw --scope user --dry-run --json
python3 mlx-agent/scripts/mlx-agent install hermes --scope user --dry-run --json
```

Review the destination paths and use the exact preview hash when confirming. `obsidian-agent` does not ship an OpenClaw or Hermes adapter.

## AgentSkills

Both plugins publish portable skills under their AgentSkills adapter. Follow the selected repository's project- or user-scope installation instructions; the catalog does not copy or fork skill content.

## Validate the catalog

Node.js 22 or newer is sufficient:

```sh
node --test
node scripts/validate-catalog.mjs
```

Validation rejects identity drift, unknown hosts, packages for undeclared hosts, duplicate entries, non-plugin products, projections that disagree with the canonical host list, repository, or package path, and any host projection that does not install the plugin's pinned release.
