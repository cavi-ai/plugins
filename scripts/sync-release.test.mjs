import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { syncRelease } from "./sync-release.mjs";
import { validateCatalog } from "./validate-catalog.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const commit = "a".repeat(40);
const tag = "v9.9.9";

async function catalogCopy() {
  const root = await mkdtemp(path.join(tmpdir(), "plugins-sync-"));
  for (const item of [".agents", ".claude-plugin", "catalog.json", "catalog.schema.json", "packages", "providers", "releases.json"]) {
    await cp(path.join(repositoryRoot, item), path.join(root, item), { recursive: true });
  }
  return root;
}

const readJson = async (root, relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));

async function mlxAgentSource(skills = ["mlx-adopt", "mlx-scout"]) {
  const source = await mkdtemp(path.join(tmpdir(), "mlx-agent-source-"));
  const provider = path.join(source, "providers/codex");
  await mkdir(path.join(provider, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(provider, ".codex-plugin/plugin.json"), JSON.stringify({ name: "mlx-agent", version: "9.9.9", skills: "./skills/" }));
  await writeFile(path.join(provider, ".mlx-agent-generated-files.json"), "{}\n");
  for (const skill of skills) {
    await mkdir(path.join(provider, "skills", skill), { recursive: true });
    await writeFile(path.join(provider, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: source\n---\n`);
  }
  await mkdir(path.join(provider, "scripts"), { recursive: true });
  await writeFile(path.join(provider, "scripts/mlx-agent"), "#!/usr/bin/env python3\n");
  await writeFile(path.join(provider, "scripts/mlx-agent-mcp"), "#!/usr/bin/env python3\n");
  await mkdir(path.join(provider, "src/mlx_agent"), { recursive: true });
  await writeFile(path.join(provider, "src/mlx_agent/__init__.py"), "__version__ = \"9.9.9\"\n");
  await writeFile(path.join(provider, "src/mlx_agent/mcp_server.py"), "transport\n");
  await writeFile(path.join(provider, "requirements-lab.txt"), "lab==1\n");
  await writeFile(path.join(provider, "requirements-lab-inference.txt"), "inference==1\n");
  return source;
}

test("points every host of a released plugin at its tag and commit", async () => {
  const root = await catalogCopy();
  await writeFile(path.join(root, "packages/codex/mlx-agent/stale.txt"), "stale\n");
  const result = await syncRelease({ root, name: "mlx-agent", source: await mlxAgentSource(), tag, commit });
  assert.deepEqual(result.hosts, ["agy", "claude", "codex", "hermes", "openclaw", "opencode"]);
  assert.deepEqual(await validateCatalog(root), []);

  assert.deepEqual((await readJson(root, "releases.json"))["mlx-agent"], { tag, commit });
  const claude = (await readJson(root, ".claude-plugin/marketplace.json")).plugins.find((entry) => entry.name === "mlx-agent");
  assert.deepEqual(claude.source, { source: "github", repo: "cavi-ai/mlx-agent", ref: tag, sha: commit });
  for (const host of ["agy", "opencode", "openclaw", "hermes"]) {
    const entry = (await readJson(root, `providers/${host}/catalog.json`)).plugins.find((item) => item.name === "mlx-agent");
    assert.match(entry.install.command, /^git clone --branch v9\.9\.9 --depth 1 https:\/\/github\.com\/cavi-ai\/mlx-agent\.git && /);
  }
  const packageRoot = path.join(root, "packages/codex/mlx-agent");
  assert.deepEqual((await readdir(packageRoot)).sort(), [".codex-plugin", "provenance.json", "requirements-lab-inference.txt", "requirements-lab.txt", "scripts", "skills", "src"]);
  assert.deepEqual(await readdir(path.join(packageRoot, "scripts")), ["mlx-agent"]);
  assert.deepEqual(await readdir(path.join(packageRoot, "src/mlx_agent")), ["__init__.py"]);
  const integrity = await readJson(root, "packages/codex/expected-integrity.json");
  assert.equal(integrity["mlx-agent"].source_commit, commit);
  assert.deepEqual(integrity["mlx-agent"].skills, ["mlx-adopt", "mlx-scout"]);

  const pins = await readJson(root, "releases.json");
  const obsidian = (await readJson(root, ".claude-plugin/marketplace.json")).plugins.find((entry) => entry.name === "obsidian-agent");
  assert.deepEqual(obsidian.source, { source: "github", repo: "cavi-ai/obsidian-agent", ref: pins["obsidian-agent"].tag, sha: pins["obsidian-agent"].commit });
});

test("syncs a plugin without a Codex package from its tag alone", async () => {
  const root = await catalogCopy();
  const result = await syncRelease({ root, name: "loop-killer", tag: "v0.1.0", commit });
  assert.deepEqual(result.hosts, ["claude"]);
  assert.deepEqual((await readJson(root, "releases.json"))["loop-killer"], { tag: "v0.1.0", commit });
  assert.deepEqual(await validateCatalog(root), []);
});

test("records the vendored skill inventory so later drift is rejected", async () => {
  const root = await catalogCopy();
  await syncRelease({ root, name: "mlx-agent", source: await mlxAgentSource(["mlx-adopt", "mlx-bench", "mlx-scout"]), tag, commit });
  assert.deepEqual(await validateCatalog(root), []);
  await mkdir(path.join(root, "packages/codex/mlx-agent/skills/mlx-extra"), { recursive: true });
  await writeFile(path.join(root, "packages/codex/mlx-agent/skills/mlx-extra/SKILL.md"), "---\nname: mlx-extra\n---\n");
  const errors = await validateCatalog(root);
  assert(errors.includes("codex package skill inventory mismatch: mlx-agent"));
  assert(errors.includes("codex package upstream digest mismatch: mlx-agent"));
});

test("refuses bad input before writing anything", async () => {
  const root = await catalogCopy();
  const files = ["releases.json", ".claude-plugin/marketplace.json", "providers/agy/catalog.json", "packages/codex/expected-integrity.json"];
  const before = await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")));
  const source = await mlxAgentSource();
  await symlink("/etc/hosts", path.join(source, "providers/codex/skills/mlx-adopt/hosts"));
  await assert.rejects(syncRelease({ root, name: "mlx-agent", source, tag, commit }), /source symlink rejected: skills\/mlx-adopt\/hosts/);
  await assert.rejects(syncRelease({ root, name: "mlx-agent", tag, commit }), /source checkout is required/);
  await assert.rejects(syncRelease({ root, name: "ghost", tag, commit }), /not a catalog plugin/);
  await assert.rejects(syncRelease({ root, name: "loop-killer", tag: "0.1.0", commit }), /tag must be vX\.Y\.Z/);
  await assert.rejects(syncRelease({ root, name: "loop-killer", tag, commit: "abc1234" }), /full lowercase SHA/);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8"))), before);
  assert.deepEqual(await validateCatalog(root), []);
  assert.deepEqual((await readdir(path.join(root, "packages/codex"))).filter((item) => item.startsWith(".")), []);
});
