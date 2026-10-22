import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { syncCodexPackage } from "./sync-codex-package.mjs";
import { validateCatalog } from "./validate-catalog.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const commit = "a".repeat(40);

async function catalogCopy() {
  const root = await mkdtemp(path.join(tmpdir(), "plugins-sync-"));
  for (const item of [".agents", ".claude-plugin", "catalog.json", "catalog.schema.json", "packages", "providers"]) {
    await cp(path.join(repositoryRoot, item), path.join(root, item), { recursive: true });
  }
  return root;
}

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

test("vendors a tagged source tree that passes catalog validation", async () => {
  const root = await catalogCopy();
  await writeFile(path.join(root, "packages/codex/mlx-agent/stale.txt"), "stale\n");
  const result = await syncCodexPackage({ root, name: "mlx-agent", source: await mlxAgentSource(), commit });
  assert.deepEqual(result.skills, ["mlx-adopt", "mlx-scout"]);
  assert.deepEqual(await validateCatalog(root), []);
  const packageRoot = path.join(root, "packages/codex/mlx-agent");
  assert.deepEqual((await readdir(packageRoot)).sort(), [".codex-plugin", "provenance.json", "requirements-lab-inference.txt", "requirements-lab.txt", "scripts", "skills", "src"]);
  assert.deepEqual(await readdir(path.join(packageRoot, "scripts")), ["mlx-agent"]);
  assert.deepEqual(await readdir(path.join(packageRoot, "src/mlx_agent")), ["__init__.py"]);
  const registry = JSON.parse(await readFile(path.join(root, "packages/codex/expected-integrity.json"), "utf8"));
  assert.equal(registry["mlx-agent"].source_commit, commit);
  assert.equal(registry["mlx-agent"].tree, JSON.parse(await readFile(path.join(packageRoot, "provenance.json"), "utf8")).integrity.tree);
  assert.equal(registry["obsidian-agent"].source_commit, JSON.parse(await readFile(path.join(repositoryRoot, "packages/codex/expected-integrity.json"), "utf8"))["obsidian-agent"].source_commit);
});

test("records the vendored skill inventory so later drift is rejected", async () => {
  const root = await catalogCopy();
  await syncCodexPackage({ root, name: "mlx-agent", source: await mlxAgentSource(["mlx-adopt", "mlx-bench", "mlx-scout"]), commit });
  assert.deepEqual(await validateCatalog(root), []);
  await mkdir(path.join(root, "packages/codex/mlx-agent/skills/mlx-extra"), { recursive: true });
  await writeFile(path.join(root, "packages/codex/mlx-agent/skills/mlx-extra/SKILL.md"), "---\nname: mlx-extra\n---\n");
  const errors = await validateCatalog(root);
  assert(errors.some((error) => error.includes("codex package skill inventory mismatch: mlx-agent")));
  assert(errors.some((error) => error.includes("codex package upstream digest mismatch: mlx-agent")));
});

test("refuses symlinks, unknown packages and abbreviated commits without touching the catalog", async () => {
  const root = await catalogCopy();
  const before = await readFile(path.join(root, "packages/codex/expected-integrity.json"), "utf8");
  const source = await mlxAgentSource();
  await symlink("/etc/hosts", path.join(source, "providers/codex/skills/mlx-adopt/hosts"));
  await assert.rejects(syncCodexPackage({ root, name: "mlx-agent", source, commit }), /source symlink rejected: skills\/mlx-adopt\/hosts/);
  await assert.rejects(syncCodexPackage({ root, name: "loop-killer", source, commit }), /no pinned Codex package/);
  await assert.rejects(syncCodexPackage({ root, name: "mlx-agent", source, commit: "abc1234" }), /full lowercase SHA/);
  assert.equal(await readFile(path.join(root, "packages/codex/expected-integrity.json"), "utf8"), before);
  assert.deepEqual(await validateCatalog(root), []);
  assert.deepEqual((await readdir(path.join(root, "packages/codex"))).filter((item) => item.startsWith(".")), []);
});
