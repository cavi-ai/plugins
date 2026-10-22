import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MARKETPLACE, claudeSource, discoveryInstallCommand, validateCatalog } from "./validate-catalog.mjs";

const hosts = ["claude", "codex", "agy", "opencode", "openclaw", "hermes", "agentskills"];
const inventories = {
  "mlx-agent": ["mlx-adopt", "mlx-bench", "mlx-scout", "mlx-wire"],
  "obsidian-agent": ["build-retrospective", "connection-finder", "consistent-tagging", "daily-rollup", "dedup-merge", "frontmatter-normalizer", "manifest-content", "manifest-core", "manifest-feature", "manifest-infra", "manifest-pm", "manifest-research", "manifest-risk", "manifest-vault", "meeting-cleanup", "moc-builder", "note-splitter", "outline-to-draft", "plan-to-spec", "source-digest", "summarize-and-link", "task-harvester", "tracker-driver", "vault-grounding", "vault-synthesis", "wikilink-weaver"]
};
const sourceCommits = { "mlx-agent": "923627988cf98e984fa36e0b940f86e7263e2958", "obsidian-agent": "7efecb058fce8185056cbe7868d6de1af11879a9" };
const releases = { "mlx-agent": { tag: "v1.0.0", commit: sourceCommits["mlx-agent"] }, "obsidian-agent": { tag: "v1.0.0", commit: sourceCommits["obsidian-agent"] } };
const pluginHosts = {
  "mlx-agent": ["claude", "codex", "agy", "opencode", "openclaw", "hermes", "agentskills"],
  "obsidian-agent": ["claude", "codex", "opencode", "agentskills"]
};

function plugin(name, repository = `cavi-ai/${name}`, supportedHosts = pluginHosts[name] ?? hosts) {
  return {
    name,
    repository,
    license: "MIT",
    summary: `${name} summary`,
    hosts: supportedHosts,
    packages: Object.fromEntries([...new Set(supportedHosts)].filter((host) => hosts.includes(host)).map((host) => [host, { path: host === "claude" ? "." : host === "codex" ? `packages/codex/${name}` : host === "agy" ? "providers/agy" : host === "opencode" ? "providers/opencode" : "providers/agentskills" }]))
  };
}

const includedRoots = {
  "mlx-agent": [".codex-plugin", "requirements-lab-inference.txt", "requirements-lab.txt", "scripts", "skills", "src"],
  "obsidian-agent": [".codex-plugin", "skills"]
};

async function fixtureTreeHash(packageRoot, roots = includedRoots[path.basename(packageRoot)]) {
  const walk = async (target) => (await stat(target)).isFile() ? [target] : (await Promise.all((await readdir(target, { withFileTypes: true })).map(async (item) => item.isDirectory() ? walk(path.join(target, item.name)) : [path.join(target, item.name)]))).flat();
  const hash = createHash("sha256");
  for (const base of roots) for (const file of (await walk(path.join(packageRoot, base))).sort()) {
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
  if (name === "mlx-agent") {
    await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
    await mkdir(path.join(packageRoot, "src/mlx_agent"), { recursive: true });
    await writeFile(path.join(packageRoot, "scripts/mlx-agent"), "#!/usr/bin/env python3\n");
    await writeFile(path.join(packageRoot, "src/mlx_agent/__init__.py"), "__version__ = \"1.0.0\"\n");
    await writeFile(path.join(packageRoot, "requirements-lab.txt"), "fixture==1\n");
    await writeFile(path.join(packageRoot, "requirements-lab-inference.txt"), "fixture==1\n");
  }
  await writeFile(path.join(packageRoot, "provenance.json"), JSON.stringify({ repository: `cavi-ai/${name}`, source_commit: sourceCommits[name], source_path: name === "mlx-agent" ? "providers/codex" : ".", included: includedRoots[name], ...(name === "mlx-agent" ? { excluded: ["scripts/mlx-agent-mcp", "src/mlx_agent/mcp_server.py"], exclusion_reason: "Codex skills use the packaged CLI entrypoint; MCP transport artifacts are not required or distributed by this catalog." } : {}), integrity: { algorithm: "sha256", tree: await fixtureTreeHash(packageRoot) } }));
}

async function fixture({ catalog, claude = [], codex = [], agy = [], opencode = [], openclaw = [], hermes = [] }) {
  const root = await mkdtemp(path.join(tmpdir(), "plugins-catalog-"));
  await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
  for (const host of ["agy", "opencode", "openclaw", "hermes"]) await mkdir(path.join(root, "providers", host), { recursive: true });
  await cp(path.resolve(new URL("../catalog.schema.json", import.meta.url).pathname), path.join(root, "catalog.schema.json"));
  await writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog));
  await writeFile(path.join(root, "releases.json"), JSON.stringify(releases));
  const nativeClaude = claude.map((item) => item.source ? item : { name: item.name, source: { ...claudeSource(item.name, releases[item.name]), repo: item.repository }, description: `${item.name} fixture` });
  const nativeCodex = codex.map((item) => item.source ? item : { name: item.name, source: { source: "local", path: `./packages/codex/${item.name}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" });
  await writeFile(path.join(root, ".claude-plugin/marketplace.json"), JSON.stringify({ name: MARKETPLACE, owner: { name: "Cavi AI", url: "https://github.com/cavi-ai" }, metadata: { description: "fixture" }, plugins: nativeClaude }));
  await writeFile(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({ name: MARKETPLACE, interface: { displayName: "Cavi AI" }, plugins: nativeCodex }));
  await writeFile(path.join(root, "providers/agy/catalog.json"), JSON.stringify({ name: MARKETPLACE, host: "agy", protocol: "discovery", plugins: agy }));
  await writeFile(path.join(root, "providers/opencode/catalog.json"), JSON.stringify({ name: MARKETPLACE, host: "opencode", protocol: "discovery", plugins: opencode }));
  await writeFile(path.join(root, "providers/openclaw/catalog.json"), JSON.stringify({ name: MARKETPLACE, host: "openclaw", protocol: "discovery", plugins: openclaw }));
  await writeFile(path.join(root, "providers/hermes/catalog.json"), JSON.stringify({ name: MARKETPLACE, host: "hermes", protocol: "discovery", plugins: hermes }));
  for (const name of Object.keys(inventories)) await createFixturePackage(root, name);
  const expectedIntegrity = {};
  for (const name of Object.keys(inventories)) {
    const provenance = JSON.parse(await readFile(path.join(root, `packages/codex/${name}/provenance.json`), "utf8"));
    expectedIntegrity[name] = { repository: provenance.repository, source_commit: provenance.source_commit, source_path: provenance.source_path, tree: provenance.integrity.tree, skills: inventories[name] };
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
  ...(["agy", "opencode", "openclaw", "hermes"].includes(host) ? { install: { command: discoveryInstallCommand(host, name, releases[name]) } } : {})
});

test("pins discovery installs and the Claude source to the released tag and commit", () => {
  const release = { tag: "v1.2.3", commit: "b".repeat(40) };
  assert.equal(discoveryInstallCommand("agy", "mlx-agent", release), "git clone --branch v1.2.3 --depth 1 https://github.com/cavi-ai/mlx-agent.git && agy plugin install ./mlx-agent/providers/agy");
  assert.equal(discoveryInstallCommand("opencode", "obsidian-agent", release), "git clone --branch v1.2.3 --depth 1 https://github.com/cavi-ai/obsidian-agent.git && node obsidian-agent/scripts/install.mjs --host opencode --scope user --dry-run");
  assert.equal(discoveryInstallCommand("hermes", "mlx-agent", undefined), "git clone https://github.com/cavi-ai/mlx-agent.git && python3 mlx-agent/scripts/mlx-agent install hermes --scope user --dry-run --json");
  assert.deepEqual(claudeSource("mlx-agent", release), { source: "github", repo: "cavi-ai/mlx-agent", ref: "v1.2.3", sha: "b".repeat(40) });
  assert.deepEqual(claudeSource("loop-killer", undefined), { source: "github", repo: "cavi-ai/loop-killer" });
});

test("rejects host projections and packages that drift from the release pin", async () => {
  const root = await fixture({ catalog: canonical, claude: [{ name: "mlx-agent", source: { source: "github", repo: "cavi-ai/mlx-agent" }, description: "unpinned" }, entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], agy: [{ ...entry("mlx-agent", "agy"), install: { command: discoveryInstallCommand("agy", "mlx-agent", undefined) } }], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")], openclaw: [entry("mlx-agent", "openclaw")], hermes: [entry("mlx-agent", "hermes")] });
  const pinsPath = path.join(root, "releases.json");
  const pins = JSON.parse(await readFile(pinsPath, "utf8"));
  pins["obsidian-agent"].commit = "c".repeat(40);
  await writeFile(pinsPath, JSON.stringify(pins));
  const errors = await validateCatalog(root);
  assert(errors.includes("claude source does not match its release pin: mlx-agent"), errors.join("\n"));
  assert(errors.includes("agy install command mismatch: mlx-agent"), errors.join("\n"));
  assert(errors.includes("codex package does not match its release pin: obsidian-agent"), errors.join("\n"));
  assert(errors.includes("claude source does not match its release pin: obsidian-agent"), errors.join("\n"));
});

test("requires well-formed release pins for every plugin with a Codex package", async () => {
  const cases = [
    [(pins) => { delete pins["mlx-agent"]; }, "release pin missing: mlx-agent"],
    [(pins) => { pins.ghost = { tag: "v1.0.0", commit: "a".repeat(40) }; }, "release pin for unknown plugin: ghost"],
    [(pins) => { pins["mlx-agent"].tag = "1.0.0"; }, "release pin mlx-agent tag must be vX.Y.Z"],
    [(pins) => { pins["mlx-agent"].commit = "abc1234"; }, "release pin mlx-agent commit must be a full lowercase commit"],
    [(pins) => { pins["mlx-agent"].branch = "main"; }, "release pin mlx-agent must have only tag and commit"]
  ];
  for (const [mutate, expected] of cases) {
    const root = await fixture({ catalog: canonical });
    const pinsPath = path.join(root, "releases.json");
    const pins = JSON.parse(await readFile(pinsPath, "utf8"));
    mutate(pins);
    await writeFile(pinsPath, JSON.stringify(pins));
    const errors = await validateCatalog(root);
    assert(errors.includes(expected), `missing ${expected}\n${errors.join("\n")}`);
  }
});

test("accepts the canonical plugins and truthful host projections", async () => {
  const root = await fixture({
    catalog: canonical,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    agy: [entry("mlx-agent", "agy")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")],
    openclaw: [entry("mlx-agent", "openclaw")],
    hermes: [entry("mlx-agent", "hermes")]
  });
  assert.deepEqual(await validateCatalog(root), []);
});

test("accepts a claude-only plugin projected only to claude", async () => {
  const withLoopKiller = { ...canonical, plugins: [...canonical.plugins, plugin("loop-killer", "cavi-ai/loop-killer", ["claude"])] };
  const loopKiller = { name: "loop-killer", repository: "cavi-ai/loop-killer", package: "." };
  const projections = {
    agy: [entry("mlx-agent", "agy")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")],
    openclaw: [entry("mlx-agent", "openclaw")],
    hermes: [entry("mlx-agent", "hermes")]
  };
  const root = await fixture({
    catalog: withLoopKiller,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude"), loopKiller],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    ...projections
  });
  assert.deepEqual(await validateCatalog(root), []);
  const projectedWide = await fixture({
    catalog: withLoopKiller,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude"), loopKiller],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    ...projections,
    opencode: [...projections.opencode, { ...loopKiller, install: { command: "git clone https://github.com/cavi-ai/loop-killer.git" } }]
  });
  const errors = await validateCatalog(projectedWide);
  assert(errors.some((error) => error.includes("opencode projects unsupported plugin host: loop-killer")));
  const unprojected = await validateCatalog(await fixture({ catalog: withLoopKiller, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], ...projections }));
  assert(unprojected.includes("claude projection missing: loop-killer"));
});

test("requires openclaw and hermes discovery records only for plugins that declare them", async () => {
  const root = await fixture({
    catalog: canonical,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    agy: [entry("mlx-agent", "agy")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")],
    openclaw: [entry("mlx-agent", "openclaw"), { name: "obsidian-agent", repository: "cavi-ai/obsidian-agent", package: "providers/agentskills", install: { command: "git clone https://github.com/cavi-ai/obsidian-agent.git && node obsidian-agent/scripts/install.mjs --host openclaw --scope user --dry-run" } }],
    hermes: [{ ...entry("mlx-agent", "hermes"), install: { command: entry("mlx-agent", "openclaw").install.command } }]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("openclaw projects unsupported plugin host: obsidian-agent")));
  assert(errors.some((error) => error.includes("openclaw install command mismatch: obsidian-agent")));
  assert(errors.some((error) => error.includes("hermes install command mismatch: mlx-agent")));
  const missing = await validateCatalog(await fixture({ catalog: canonical }));
  assert(missing.includes("openclaw projection missing: mlx-agent"));
  assert(missing.includes("hermes projection missing: mlx-agent"));
  assert(!missing.some((error) => error.includes("projection missing: obsidian-agent") && /^(openclaw|hermes) /.test(error)));
});

test("rejects a discovery projection for a host the plugin does not declare", async () => {
  const root = await fixture({
    catalog: canonical,
    claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    agy: [entry("mlx-agent", "agy"), { name: "obsidian-agent", repository: "cavi-ai/obsidian-agent", package: ".", install: { command: "git clone https://github.com/cavi-ai/obsidian-agent.git && agy plugin install ./obsidian-agent" } }],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("agy projects unsupported plugin host: obsidian-agent")));
  assert(errors.some((error) => error.includes("agy install command mismatch: obsidian-agent")));
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
    agy: [],
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
    agy: [entry("mlx-agent", "agy")],
    opencode: [entry("mlx-agent", "opencode"), { ...entry("obsidian-agent", "opencode"), package: "wrong" }]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("claude repository mismatch: mlx-agent")));
  assert(errors.some((error) => error.includes("opencode package mismatch: obsidian-agent")));
});

test("rejects duplicate hosts, packages for undeclared hosts, and duplicate projection entries", async () => {
  const incomplete = {
    name: MARKETPLACE,
    plugins: [plugin("mlx-agent", "cavi-ai/mlx-agent", ["claude", "claude", "codex", "opencode"]), plugin("obsidian-agent")]
  };
  incomplete.plugins[0].packages.agy = { path: "providers/agy" };
  const root = await fixture({
    catalog: incomplete,
    claude: [entry("mlx-agent", "claude"), entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")],
    codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")],
    agy: [entry("mlx-agent", "agy")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("duplicate host: claude")));
  assert(errors.some((error) => error.includes("catalog plugin mlx-agent package for undeclared host: agy")));
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
    agy: [{ ...entry("mlx-agent", "agy"), install: undefined }],
    opencode: [{ ...entry("mlx-agent", "opencode"), install: {} }, entry("obsidian-agent", "opencode")]
  });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("agy install command missing: mlx-agent")));
  assert(errors.some((error) => error.includes("opencode install command missing: mlx-agent")));
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
    agy: [entry("mlx-agent", "agy")],
    opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")]
  });
  await mkdir(path.join(root, "packages/codex"), { recursive: true });
  await cp(path.join(sourceRoot, "packages/codex/obsidian-agent"), path.join(root, "packages/codex/obsidian-agent"), { recursive: true });
  await writeFile(path.join(root, "packages/codex/obsidian-agent/skills/vault-grounding/SKILL.md"), "tampered\n");
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("codex package integrity mismatch: obsidian-agent")));
});

test("rejects vendored drift even when package-local provenance is recomputed", async () => {
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], agy: [entry("mlx-agent", "agy")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
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
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], agy: [entry("mlx-agent", "agy")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
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
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], agy: [entry("mlx-agent", "agy")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
  const outside = path.join(root, "outside.md");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(root, "packages/codex/obsidian-agent/skills/vault-grounding/live.md"));
  await symlink(path.join(root, "missing.md"), path.join(root, "packages/codex/obsidian-agent/skills/vault-grounding/dangling.md"));
  const errors = await validateCatalog(root);
  assert(errors.filter((error) => error.includes("codex package symlink rejected: obsidian-agent")).length >= 2);
});

test("rejects package-root and included-root symlinks", async () => {
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], agy: [entry("mlx-agent", "agy")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
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
  const root = await fixture({ catalog: badCatalog, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], agy: [entry("mlx-agent", "agy")], opencode: [entry("mlx-agent", "opencode"), entry("obsidian-agent", "opencode")] });
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
    [(catalog) => { catalog.plugins[0].hosts = []; }, "catalog schema violation: plugins[0].hosts must contain at least 1 item"],
    [(catalog) => { catalog.plugins[0].hosts.push("claude"); }, "catalog schema violation: plugins[0].hosts must contain unique items"],
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
    [(registry) => { registry["obsidian-agent"].tree = "0".repeat(63); }, "trusted integrity obsidian-agent tree must be 64 lowercase hexadecimal characters"],
    [(registry) => { registry["mlx-agent"].source_commit = "main"; }, "trusted integrity mlx-agent source_commit must be a full lowercase commit"],
    [(registry) => { registry["mlx-agent"].skills = ["mlx-wire", "mlx-adopt"]; }, "trusted integrity mlx-agent skills must be sorted unique skill names"],
    [(registry) => { delete registry["obsidian-agent"].skills; }, "trusted integrity obsidian-agent skills must be sorted unique skill names"]
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
  const root = await fixture({ catalog: canonical, claude: [entry("mlx-agent", "claude"), entry("obsidian-agent", "claude")], codex: [entry("mlx-agent", "codex"), entry("obsidian-agent", "codex")], agy: [entry("mlx-agent", "agy")], opencode: [{ ...entry("mlx-agent", "opencode"), install: { command: entry("obsidian-agent", "opencode").install.command } }, entry("obsidian-agent", "opencode")] });
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("opencode install command mismatch: mlx-agent")));
});
