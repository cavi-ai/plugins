import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateCatalog } from "./validate-catalog.mjs";

const hosts = ["claude", "codex", "gemini", "opencode", "agentskills"];

function plugin(name, repository = `cavi-ai/${name}`, supportedHosts = hosts) {
  return {
    name,
    repository,
    license: "MIT",
    summary: `${name} summary`,
    hosts: supportedHosts,
    packages: Object.fromEntries(hosts.map((host) => [host, { path: host === "claude" ? ".claude-plugin" : host === "codex" ? ".codex-plugin" : host === "gemini" ? "gemini-extension.json" : host === "opencode" ? "providers/opencode" : "providers/agentskills" }]))
  };
}

async function fixture({ catalog, claude = [], codex = [], gemini = [], opencode = [] }) {
  const root = await mkdtemp(path.join(tmpdir(), "plugins-catalog-"));
  await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
  await mkdir(path.join(root, "providers/gemini"), { recursive: true });
  await mkdir(path.join(root, "providers/opencode"), { recursive: true });
  await writeFile(path.join(root, "catalog.schema.json"), JSON.stringify({ type: "object" }));
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  await writeFile(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "plugins", plugins: claude }));
  await writeFile(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "plugins", plugins: codex }));
  await writeFile(path.join(root, "providers/gemini/catalog.json"), JSON.stringify({ name: "plugins", host: "gemini", protocol: "discovery", plugins: gemini }));
  await writeFile(path.join(root, "providers/opencode/catalog.json"), JSON.stringify({ name: "plugins", host: "opencode", protocol: "discovery", plugins: opencode }));
  return root;
}

const canonical = {
  name: "plugins",
  plugins: [plugin("mlx-agent"), plugin("obsidian-agent")]
};

const entry = (name, host) => ({
  name,
  repository: `cavi-ai/${name}`,
  package: canonical.plugins.find((item) => item.name === name).packages[host].path,
  ...(host === "gemini" || host === "opencode" ? { install: { command: `install ${name}` } } : {})
});

test("accepts exactly the two canonical plugins and truthful host projections", async () => {
  const root = await fixture({
    catalog: canonical,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  assert.deepEqual(await validateCatalog(root), []);
});

test("rejects duplicates, unknown hosts, missing repositories, and legacy identities", async () => {
  const bad = {
    name: "claude-plugins",
    plugins: [
      plugin("mlx-agent", "", ["claude", "other"]),
      plugin("mlx-agent"),
      plugin("claude-obsidian")
    ]
  };
  const errors = await validateCatalog(await fixture({ catalog: bad }));
  assert(errors.some((error) => error.includes("catalog name must be plugins")));
  assert(errors.some((error) => error.includes("duplicate plugin name: mlx-agent")));
  assert(errors.some((error) => error.includes("unknown host: other")));
  assert(errors.some((error) => error.includes("repository is required")));
  assert(errors.some((error) => error.includes("legacy identity")));
});

test("rejects missing required plugins and non-installable extras", async () => {
  const errors = await validateCatalog(await fixture({ catalog: { name: "plugins", plugins: [plugin("mlx-agent"), plugin("bobby-browser")] } }));
  assert(errors.some((error) => error.includes("required plugin missing: obsidian-agent")));
  assert(errors.some((error) => error.includes("unexpected plugin: bobby-browser")));
});

test("rejects absent projection entries and unsupported or mismatched projections", async () => {
  const limited = { name: "plugins", plugins: [plugin("mlx-agent"), plugin("obsidian-agent", "cavi-ai/obsidian-agent", ["claude"])] };
  const root = await fixture({
    catalog: limited,
    claude: [entry("mlx-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex"), { name: "ghost", repository: "cavi-ai/ghost", package: ".codex-plugin" }],
    gemini: [entry("mlx-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode")]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("claude projection missing: obsidian-agent")));
  assert(errors.some((error) => error.includes("codex projects unsupported plugin host: obsidian-agent")));
  assert(errors.some((error) => error.includes("codex projects unknown plugin: ghost")));
});

test("rejects repository identity and package path mismatches", async () => {
  const root = await fixture({
    catalog: canonical,
    claude: [{ ...entry("mlx-agent", "claude"), repository: "other/mlx-agent" }, entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), { ...entry("obsidian-agent", "opencode"), package: "wrong" }]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("claude repository mismatch: mlx-agent")));
  assert(errors.some((error) => error.includes("opencode package mismatch: obsidian-agent")));
});

test("requires the complete host matrix without duplicate host or projection entries", async () => {
  const incomplete = {
    name: "plugins",
    plugins: [plugin("mlx-agent", "cavi-ai/mlx-agent", ["claude", "claude", "codex", "gemini", "opencode"]), plugin("obsidian-agent")]
  };
  const root = await fixture({
    catalog: incomplete,
    claude: [entry("mlx-agent", "claude"), entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("duplicate host: claude")));
  assert(errors.some((error) => error.includes("required host missing: agentskills")));
  assert(errors.some((error) => error.includes("claude duplicate projection: mlx-agent")));
});

test("requires each canonical repository to match the plugin identity", async () => {
  const wrongRepository = {
    name: "plugins",
    plugins: [plugin("mlx-agent", "cavi-ai/not-mlx-agent"), plugin("obsidian-agent")]
  };
  const errors = await validateCatalog(await fixture({ catalog: wrongRepository }));
  assert(errors.some((error) => error.includes("repository identity mismatch: mlx-agent")));
});

test("requires explicit install commands in discovery projections", async () => {
  const root = await fixture({
    catalog: canonical,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    gemini: [{ ...entry("mlx-agent", "gemini"), install: undefined }, entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), { ...entry("obsidian-agent", "opencode"), install: {} }]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("gemini install command missing: mlx-agent")));
  assert(errors.some((error) => error.includes("opencode install command missing: obsidian-agent")));
});

test("the published Codex projection uses resolvable marketplace-local packages", async () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const projection = JSON.parse(await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
  for (const plugin of projection.plugins) {
    assert.equal(plugin.source.source, "local");
    assert.match(plugin.source.path, /^\.\/packages\/codex\/[a-z0-9-]+$/);
    const packageRoot = path.resolve(root, plugin.source.path);
    assert.equal((await stat(packageRoot)).isDirectory(), true);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, ".codex-plugin/plugin.json"), "utf8"));
    assert.equal(manifest.name, plugin.name);
  }
});

test("rejects drift inside a pinned Codex package", async () => {
  const sourceRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const root = await fixture({
    catalog: canonical,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), { name: "obsidian-agent", source: { source: "local", path: "./packages/codex/obsidian-agent" } }],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  await mkdir(path.join(root, "packages/codex"), { recursive: true });
  await cp(path.join(sourceRoot, "packages/codex/obsidian-agent"), path.join(root, "packages/codex/obsidian-agent"), { recursive: true });
  await writeFile(path.join(root, "packages/codex/obsidian-agent/skills/vault-grounding/SKILL.md"), "tampered\n");
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("codex package integrity mismatch: obsidian-agent")));
});
