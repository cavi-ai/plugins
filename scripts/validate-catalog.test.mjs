import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MARKETPLACE, validateCatalog } from "./validate-catalog.mjs";

const hosts = ["claude", "codex", "gemini", "opencode", "agentskills"];
const inventories = {
  "mlx-agent": ["mlx-adopt", "mlx-bench", "mlx-scout", "mlx-wire"],
  "obsidian-agent": ["build-retrospective", "connection-finder", "consistent-tagging", "daily-rollup", "dedup-merge", "frontmatter-normalizer", "manifest-content", "manifest-core", "manifest-feature", "manifest-infra", "manifest-pm", "manifest-research", "manifest-risk", "manifest-vault", "meeting-cleanup", "moc-builder", "note-splitter", "outline-to-draft", "plan-to-spec", "source-digest", "summarize-and-link", "task-harvester", "tracker-driver", "vault-grounding", "vault-synthesis", "wikilink-weaver"]
};
const sourceCommits = { "mlx-agent": "923627988cf98e984fa36e0b940f86e7263e2958", "obsidian-agent": "7efecb058fce8185056cbe7868d6de1af11879a9" };

function plugin(name, repository = `cavi-ai/${name}`, supportedHosts = hosts) {
  return {
    name,
    repository,
    license: "MIT",
    summary: `${name} summary`,
    hosts: supportedHosts,
    packages: Object.fromEntries([...new Set(supportedHosts)].filter((host) => hosts.includes(host)).map((host) => [host, { path: host === "claude" ? "." : host === "codex" ? `packages/codex/${name}` : host === "gemini" ? (name === "mlx-agent" ? "providers/gemini" : ".") : host === "opencode" ? "providers/opencode" : "providers/agentskills" }]))
  };
}

async function fixtureTreeHash(packageRoot) {
  const walk = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (item) => item.isDirectory() ? walk(path.join(directory, item.name)) : [path.join(directory, item.name)]))).flat();
  const hash = createHash("sha256");
  for (const base of [".codex-plugin", "skills"]) for (const file of (await walk(path.join(packageRoot, base))).sort()) {
    hash.update(path.relative(packageRoot, file)); hash.update("\0"); hash.update(await readFile(file)); hash.update("\0");
  }
  return hash.digest("hex");
}

async function createFixturePackage(root, name) {
  const packageRoot = path.join(root, `packages/codex/${name}`);
  await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(packageRoot, ".codex-plugin/plugin.json"), JSON.stringify({ name, version: "1.0.0", description: name, author: { name: "CAVI" }, license: "MIT", skills: "./skills/", interface: { displayName: name, shortDescription: name, longDescription: name, developerName: "CAVI", category: "Productivity", capabilities: ["Knowledge"] } }));
  for (const skill of inventories[name]) {
    await mkdir(path.join(packageRoot, "skills", skill), { recursive: true });
    await writeFile(path.join(packageRoot, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: fixture\n---\n`);
  }
  await writeFile(path.join(packageRoot, "provenance.json"), JSON.stringify({ repository: `cavi-ai/${name}`, source_commit: sourceCommits[name], source_path: name === "mlx-agent" ? "providers/codex" : ".", included: [".codex-plugin", "skills"], ...(name === "mlx-agent" ? { excluded: [".mlx-agent-generated-files.json", "skills/*/scripts/mlx-agent-mcp", "skills/*/src/mlx_agent/mcp_server.py"], exclusion_reason: "Codex skills use the packaged CLI entrypoint; MCP transport artifacts are not required or distributed by this catalog." } : {}), integrity: { algorithm: "sha256", tree: await fixtureTreeHash(packageRoot) } }));
}

async function fixture({ catalog, claude = [], codex = [], gemini = [], opencode = [] }) {
  const root = await mkdtemp(path.join(tmpdir(), "plugins-catalog-"));
  await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
  await mkdir(path.join(root, "providers/gemini"), { recursive: true });
  await mkdir(path.join(root, "providers/opencode"), { recursive: true });
  await cp(path.resolve(new URL("../catalog.schema.json", import.meta.url).pathname), path.join(root, "catalog.schema.json"));
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  const nativeClaude = claude.map((item) => item.source ? item : { name: item.name, source: { source: "github", repo: item.repository }, description: `${item.name} fixture` });
  const nativeCodex = codex.map((item) => item.source ? item : { name: item.name, source: { source: "local", path: `./packages/codex/${item.name}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" });
  await writeFile(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify({ name: MARKETPLACE, owner: { name: "Cavi AI", url: "https://github.com/cavi-ai" }, metadata: { description: "fixture" }, plugins: nativeClaude }));
  await writeFile(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({ name: MARKETPLACE, interface: { displayName: "Cavi AI" }, plugins: nativeCodex }));
  await writeFile(path.join(root, "providers/gemini/catalog.json"), JSON.stringify({ name: MARKETPLACE, host: "gemini", protocol: "discovery", plugins: gemini }));
  await writeFile(path.join(root, "providers/opencode/catalog.json"), JSON.stringify({ name: MARKETPLACE, host: "opencode", protocol: "discovery", plugins: opencode }));
  for (const name of Object.keys(inventories)) await createFixturePackage(root, name);
  const expectedIntegrity = {};
  for (const name of Object.keys(inventories)) {
    const provenance = JSON.parse(await readFile(path.join(root, `packages/codex/${name}/provenance.json`), "utf8"));
    expectedIntegrity[name] = { repository: provenance.repository, source_commit: provenance.source_commit, source_path: provenance.source_path, tree: provenance.integrity.tree };
  }
  await writeFile(path.join(root, "packages/codex/expected-integrity.json"), JSON.stringify(expectedIntegrity));
  return root;
}

const canonical = {
  $schema: "./catalog.schema.json",
  name: MARKETPLACE,
  plugins: [plugin("mlx-agent"), plugin("obsidian-agent")]
};

const entry = (name, host) => ({
  name,
  repository: `cavi-ai/${name}`,
  package: canonical.plugins.find((item) => item.name === name).packages[host].path,
  ...(host === "gemini" ? { install: { command: name === "mlx-agent" ? "git clone https://github.com/cavi-ai/mlx-agent.git && gemini extensions install ./mlx-agent/providers/gemini" : "gemini extensions install https://github.com/cavi-ai/obsidian-agent" } } : {}),
  ...(host === "opencode" ? { install: { command: name === "mlx-agent" ? "git clone https://github.com/cavi-ai/mlx-agent.git && python3 mlx-agent/scripts/mlx-agent install opencode --scope user --dry-run --json" : "git clone https://github.com/cavi-ai/obsidian-agent.git && node obsidian-agent/scripts/install.mjs --host opencode --scope user --dry-run" } } : {})
});

test("accepts the canonical plugins and truthful host projections", async () => {
  const root = await fixture({
    catalog: canonical,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  assert.deepEqual(await validateCatalog(root), []);
});

test("accepts a claude-only plugin projected only to claude", async () => {
  const withHarness = { ...canonical, plugins: [...canonical.plugins, plugin("harness", "cavi-ai/harness", ["claude"])] };
  const root = await fixture({
    catalog: withHarness,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude"), { name: "harness", repository: "cavi-ai/harness", package: "." }],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  assert.deepEqual(await validateCatalog(root), []);
  const projectedWide = await fixture({
    catalog: withHarness,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude"), { name: "harness", repository: "cavi-ai/harness", package: "." }],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex"), { name: "harness", repository: "cavi-ai/harness", package: "packages/codex/harness" }],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  const errors = await validateCatalog(projectedWide);
  assert(errors.some((error) => error.includes("codex projects unsupported plugin host: harness")));
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
  assert(errors.some((error) => error.includes(`catalog name must be ${MARKETPLACE}`)));
  assert(errors.some((error) => error.includes("duplicate plugin name: mlx-agent")));
  assert(errors.some((error) => error.includes("unknown host: other")));
  assert(errors.some((error) => error.includes("repository is required")));
  assert(errors.some((error) => error.includes("legacy identity")));
});

test("rejects missing required plugins and non-installable extras", async () => {
  const errors = await validateCatalog(await fixture({ catalog: { name: MARKETPLACE, plugins: [plugin("mlx-agent"), plugin("bobby-browser")] } }));
  assert(errors.some((error) => error.includes("required plugin missing: obsidian-agent")));
  assert(errors.some((error) => error.includes("unexpected plugin: bobby-browser")));
});

test("rejects absent projection entries and unsupported or mismatched projections", async () => {
  const limited = { name: MARKETPLACE, plugins: [plugin("mlx-agent"), plugin("obsidian-agent", "cavi-ai/obsidian-agent", ["claude"])] };
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

test("rejects duplicate hosts, undeclared host packages, and duplicate projection entries", async () => {
  const incomplete = {
    name: MARKETPLACE,
    plugins: [plugin("mlx-agent", "cavi-ai/mlx-agent", ["claude", "claude", "codex", "gemini", "opencode"]), plugin("obsidian-agent")]
  };
  incomplete.plugins[0].packages.agentskills = { path: "providers/agentskills" };
  const root = await fixture({
    catalog: incomplete,
    claude: [entry("mlx-agent", "claude"), entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("duplicate host: claude")));
  assert(errors.some((error) => error.includes("catalog plugin mlx-agent package for undeclared host: agentskills")));
  assert(errors.some((error) => error.includes("claude duplicate projection: mlx-agent")));
});

test("requires each canonical repository to match the plugin identity", async () => {
  const wrongRepository = {
    name: MARKETPLACE,
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

test("rejects vendored drift even when package-local provenance is recomputed", async () => {
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
  const packageRoot = path.join(root, "packages/codex/obsidian-agent");
  await writeFile(path.join(packageRoot, "skills/vault-grounding/SKILL.md"), "---\nname: vault-grounding\ndescription: attacker content\n---\n");
  const provenancePath = path.join(packageRoot, "provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.integrity.tree = await fixtureTreeHash(packageRoot);
  await writeFile(provenancePath, JSON.stringify(provenance));
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("codex package upstream digest mismatch: obsidian-agent")));
});

test("rejects self-selected integrity roots and missing authoritative skills", async () => {
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
  const packageRoot = path.join(root, "packages/codex/obsidian-agent");
  await rm(path.join(packageRoot, "skills/wikilink-weaver"), { recursive: true });
  const provenancePath = path.join(packageRoot, "provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.included = [".codex-plugin"];
  provenance.integrity.tree = createHash("sha256").update("attacker controlled").digest("hex");
  await writeFile(provenancePath, JSON.stringify(provenance));
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("included roots mismatch: obsidian-agent")));
  assert(errors.some((error) => error.includes("skill inventory mismatch: obsidian-agent")));
});

test("rejects live and dangling symlinks in Codex package trees", async () => {
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
  const outside = path.join(root, "outside.md");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(root, "packages/codex/obsidian-agent/skills/vault-grounding/live.md"));
  await symlink(path.join(root, "missing.md"), path.join(root, "packages/codex/obsidian-agent/skills/vault-grounding/dangling.md"));
  const errors = await validateCatalog(root);
  assert(errors.filter((error) => error.includes("codex package symlink rejected: obsidian-agent")).length >= 2);
});

test("rejects package-root and included-root symlinks", async () => {
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
  const obsidianPackage = path.join(root, "packages/codex/obsidian-agent");
  const outsidePackage = path.join(root, "outside-obsidian-package");
  await cp(obsidianPackage, outsidePackage, { recursive: true });
  await rm(obsidianPackage, { recursive: true });
  await symlink(outsidePackage, obsidianPackage);
  const mlxManifest = path.join(root, "packages/codex/mlx-agent/.codex-plugin");
  const outsideManifest = path.join(root, "outside-mlx-manifest");
  await cp(mlxManifest, outsideManifest, { recursive: true });
  await rm(mlxManifest, { recursive: true });
  await symlink(outsideManifest, mlxManifest);
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("codex package root invalid: obsidian-agent")));
  assert(errors.some((error) => error.includes("codex package symlink rejected: mlx-agent")));
});

test("applies canonical schema and rejects malformed native projections", async () => {
  const badCatalog = { ...canonical, unexpected: true };
  const root = await fixture({ catalog: badCatalog, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], gemini: [entry("mlx-agent", "gemini"), entry("obsidian-agent", "gemini")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
  const claude = JSON.parse(await readFile(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
  claude.plugins[0] = { name: "mlx-agent", repository: "cavi-ai/mlx-agent", package: "." };
  await writeFile(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify(claude));
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("catalog unknown property: unexpected")));
  assert(errors.some((error) => error.includes("claude native source invalid: mlx-agent")));
});

test("applies every nested catalog package schema type", async () => {
  const badCatalog = structuredClone(canonical);
  badCatalog.plugins[0].packages.agentskills.path = 42;
  const errors = await validateCatalog(await fixture({ catalog: badCatalog }));
  assert(errors.some((error) => error.includes("catalog schema violation: plugins[0].packages.agentskills.path must be a non-empty string")));
});

test("enforces fixed schema object, array, required, enum, and additional-properties constraints", async () => {
  const cases = [
    [(catalog) => { catalog.extra = true; }, "catalog unknown property: extra"],
    [(catalog) => { catalog.plugins[0] = []; }, "catalog schema violation: plugins[0] must be an object"],
    [(catalog) => { delete catalog.plugins[0].license; }, "catalog schema violation: plugins[0].license is required"],
    [(catalog) => { catalog.plugins[0].name = "other"; }, "catalog schema violation: plugins[0].name must be a canonical plugin name"],
    [(catalog) => { catalog.plugins[0].hosts = "claude"; }, "catalog schema violation: plugins[0].hosts must be an array"],
    [(catalog) => { catalog.plugins[0].hosts[4] = "claude"; }, "catalog schema violation: plugins[0].hosts must contain unique items"],
    [(catalog) => { catalog.plugins[0].packages = []; }, "catalog schema violation: plugins[0].packages must be an object"],
    [(catalog) => { delete catalog.plugins[0].packages.codex; }, "catalog schema violation: plugins[0].packages.codex is required"],
    [(catalog) => { catalog.plugins[0].packages.codex = "local"; }, "catalog schema violation: plugins[0].packages.codex must be an object"],
    [(catalog) => { catalog.plugins[0].packages.codex.extra = true; }, "catalog plugin mlx-agent codex package unknown property: extra"],
    [(catalog) => { catalog.plugins[0].packages.codex.path = ""; }, "catalog schema violation: plugins[0].packages.codex.path must be a non-empty string"]
  ];
  for (const [mutate, expected] of cases) {
    const badCatalog = structuredClone(canonical);
    mutate(badCatalog);
    const errors = await validateCatalog(await fixture({ catalog: badCatalog }));
    assert(errors.some((error) => error.includes(expected)), `missing ${expected}\n${errors.join("\n")}`);
  }
});

test("never short-circuits successfully parsed falsy catalog roots", async () => {
  for (const catalog of [null, false, 0, "", []]) {
    const errors = await validateCatalog(await fixture({ catalog }));
    assert(errors.some((error) => error.includes("catalog schema violation: root must be an object")), `accepted catalog root ${JSON.stringify(catalog)}\n${errors.join("\n")}`);
  }
});

test("requires a closed and fully typed trusted-integrity registry", async () => {
  const cases = [
    [null, "trusted integrity registry must be an object"],
    [{}, "trusted integrity registry missing package: mlx-agent"],
    [(registry) => { registry.ghost = structuredClone(registry["mlx-agent"]); }, "trusted integrity registry unexpected package: ghost"],
    [(registry) => { delete registry["obsidian-agent"]; }, "trusted integrity registry missing package: obsidian-agent"],
    [(registry) => { registry["mlx-agent"].extra = true; }, "trusted integrity mlx-agent unexpected property: extra"],
    [(registry) => { delete registry["mlx-agent"].source_path; }, "trusted integrity mlx-agent source_path mismatch"],
    [(registry) => { registry["obsidian-agent"].tree = "A".repeat(64); }, "trusted integrity obsidian-agent tree must be 64 lowercase hexadecimal characters"],
    [(registry) => { registry["obsidian-agent"].tree = "0".repeat(63); }, "trusted integrity obsidian-agent tree must be 64 lowercase hexadecimal characters"]
  ];
  for (const [mutateOrValue, expected] of cases) {
    const root = await fixture({ catalog: canonical });
    const registryPath = path.join(root, "packages/codex/expected-integrity.json");
    let registry = JSON.parse(await readFile(registryPath, "utf8"));
    if (typeof mutateOrValue === "function") mutateOrValue(registry);
    else registry = mutateOrValue;
    await writeFile(registryPath, JSON.stringify(registry));
    const errors = await validateCatalog(root);
    assert(errors.some((error) => error.includes(expected)), `missing ${expected}\n${errors.join("\n")}`);
  }
});

test("rejects cross-plugin discovery command drift", async () => {
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], gemini: [{ ...entry("mlx-agent", "gemini"), install: { command: "gemini extensions install https://github.com/cavi-ai/obsidian-agent" } }, entry("obsidian-agent", "gemini")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("gemini install command mismatch: mlx-agent")));
});
