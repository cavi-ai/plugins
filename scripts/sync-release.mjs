#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL, CODEX_PACKAGES, DISCOVERY_HOSTS, RELEASES, claudeSource, discoveryInstallCommand, packageTreeHash } from "./validate-catalog.mjs";

const CLAUDE_MARKETPLACE = ".claude-plugin/marketplace.json";
const CODEX_INTEGRITY = "packages/codex/expected-integrity.json";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

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

async function stageCodexPackage({ root, name, source, commit }) {
  const config = CODEX_PACKAGES[name];
  if (typeof source !== "string" || !source) throw new Error(`${name} ships a Codex package, so a source checkout is required`);
  const staging = await mkdtemp(path.join(root, "packages/codex", `.${name}-`));
  try {
    const excluded = new Set(config.excluded ?? []);
    for (const base of config.included) await copyTree(path.join(source, config.sourcePath, base), path.join(staging, base), base, excluded);
    const skills = (await readdir(path.join(staging, "skills"), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
    const tree = await packageTreeHash(staging, config.included);
    await writeJson(path.join(staging, "provenance.json"), {
      repository: `cavi-ai/${name}`,
      source_commit: commit,
      source_path: config.sourcePath,
      included: config.included,
      ...(config.excluded ? { excluded: config.excluded, exclusion_reason: config.exclusionReason } : {}),
      integrity: { algorithm: "sha256", tree }
    });
    return { staging, record: { repository: `cavi-ai/${name}`, source_commit: commit, source_path: config.sourcePath, tree, skills } };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

// Point every host projection of one plugin at a release: the release pin, the Claude marketplace
// source, each discovery install command and, when the plugin ships one, the vendored Codex package.
export async function syncRelease({ root, name, source, tag, commit }) {
  if (!CANONICAL.includes(name)) throw new Error(`not a catalog plugin: ${name}`);
  if (typeof tag !== "string" || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error("tag must be vX.Y.Z");
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full lowercase SHA");
  const release = { tag, commit };

  const releases = await readJson(path.join(root, RELEASES));
  const pinned = Object.fromEntries(CANONICAL.filter((plugin) => plugin === name || Object.hasOwn(releases, plugin)).map((plugin) => [plugin, plugin === name ? release : releases[plugin]]));
  const hosts = [];
  const claude = await readJson(path.join(root, CLAUDE_MARKETPLACE));
  for (const entry of claude.plugins) if (entry.name === name) { entry.source = claudeSource(name, release); hosts.push("claude"); }
  const discovery = {};
  for (const host of DISCOVERY_HOSTS) {
    discovery[host] = await readJson(path.join(root, `providers/${host}/catalog.json`));
    for (const entry of discovery[host].plugins) {
      if (entry.name !== name) continue;
      entry.install = { ...entry.install, command: discoveryInstallCommand(host, name, release) };
      hosts.push(host);
    }
  }
  const staged = CODEX_PACKAGES[name] ? await stageCodexPackage({ root, name, source, commit }) : null;
  try {
    await writeJson(path.join(root, RELEASES), pinned);
    await writeJson(path.join(root, CLAUDE_MARKETPLACE), claude);
    for (const host of DISCOVERY_HOSTS) await writeJson(path.join(root, `providers/${host}/catalog.json`), discovery[host]);
    if (staged) {
      const integrity = await readJson(path.join(root, CODEX_INTEGRITY));
      integrity[name] = staged.record;
      const packageRoot = path.join(root, "packages/codex", name);
      await rm(packageRoot, { recursive: true, force: true });
      await rename(staged.staging, packageRoot);
      await writeJson(path.join(root, CODEX_INTEGRITY), integrity);
      hosts.push("codex");
    }
  } finally {
    if (staged) await rm(staged.staging, { recursive: true, force: true });
  }
  return { name, tag, commit, hosts: hosts.sort(), ...(staged ? { codex: { tree: staged.record.tree, skills: staged.record.skills } } : {}) };
}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const argv = process.argv.slice(2);
  try {
    const result = await syncRelease({ root: process.cwd(), name: option(argv, "--name"), source: option(argv, "--source"), tag: option(argv, "--tag"), commit: option(argv, "--commit") });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
