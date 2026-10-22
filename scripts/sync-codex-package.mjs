#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODEX_PACKAGES, packageTreeHash } from "./validate-catalog.mjs";

async function copyTree(source, target, relative, excluded) {
  const entry = await lstat(source);
  if (entry.isSymbolicLink()) throw new Error(`source symlink rejected: ${relative}`);
  if (entry.isFile()) {
    if (excluded.has(relative)) return;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    return;
  }
  if (!entry.isDirectory()) throw new Error(`source entry is not a file or directory: ${relative}`);
  for (const name of (await readdir(source)).sort()) {
    await copyTree(path.join(source, name), path.join(target, name), path.posix.join(relative, name), excluded);
  }
}

export async function syncCodexPackage({ root, name, source, commit }) {
  const config = CODEX_PACKAGES[name];
  if (!config) throw new Error(`no pinned Codex package: ${name}`);
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full lowercase SHA");
  if (typeof source !== "string" || !source) throw new Error("source checkout is required");
  const sourceRoot = path.join(source, config.sourcePath);
  const codexRoot = path.join(root, "packages/codex");
  const packageRoot = path.join(codexRoot, name);
  const staging = await mkdtemp(path.join(codexRoot, `.${name}-`));
  try {
    const excluded = new Set(config.excluded ?? []);
    for (const base of config.included) await copyTree(path.join(sourceRoot, base), path.join(staging, base), base, excluded);
    const skills = (await readdir(path.join(staging, "skills"), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
    const tree = await packageTreeHash(staging, config.included);
    const provenance = {
      repository: `cavi-ai/${name}`,
      source_commit: commit,
      source_path: config.sourcePath,
      included: config.included,
      ...(config.excluded ? { excluded: config.excluded, exclusion_reason: config.exclusionReason } : {}),
      integrity: { algorithm: "sha256", tree }
    };
    await writeFile(path.join(staging, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    const registryPath = path.join(codexRoot, "expected-integrity.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry[name] = { repository: `cavi-ai/${name}`, source_commit: commit, source_path: config.sourcePath, tree, skills };
    await rm(packageRoot, { recursive: true, force: true });
    await rename(staging, packageRoot);
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    return { name, commit, tree, skills };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const argv = process.argv.slice(2);
  try {
    const result = await syncCodexPackage({ root: process.cwd(), name: option(argv, "--name"), source: option(argv, "--source"), commit: option(argv, "--commit") });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
