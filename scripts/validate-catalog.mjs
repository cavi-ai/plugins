#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOSTS = ["claude", "codex", "gemini", "opencode", "agentskills"];
// Marketplace identity: what users type after @ in `plugin install <name>@<marketplace>`.
export const MARKETPLACE = "cavi-ai";
const REQUIRED = ["mlx-agent", "obsidian-agent"];
const INCLUDED_ROOTS = [".codex-plugin", "skills"];
const SKILL_INVENTORIES = {
  "mlx-agent": ["mlx-adopt", "mlx-bench", "mlx-scout", "mlx-wire"],
  "obsidian-agent": ["build-retrospective", "connection-finder", "consistent-tagging", "daily-rollup", "dedup-merge", "frontmatter-normalizer", "manifest-content", "manifest-core", "manifest-feature", "manifest-infra", "manifest-pm", "manifest-research", "manifest-risk", "manifest-vault", "meeting-cleanup", "moc-builder", "note-splitter", "outline-to-draft", "plan-to-spec", "source-digest", "summarize-and-link", "task-harvester", "tracker-driver", "vault-grounding", "vault-synthesis", "wikilink-weaver"]
};
const SOURCE_COMMITS = { "mlx-agent": "923627988cf98e984fa36e0b940f86e7263e2958", "obsidian-agent": "7efecb058fce8185056cbe7868d6de1af11879a9" };
const SOURCE_PATHS = { "mlx-agent": "providers/codex", "obsidian-agent": "." };
const MLX_EXCLUDED = [".mlx-agent-generated-files.json", "skills/*/scripts/mlx-agent-mcp", "skills/*/src/mlx_agent/mcp_server.py"];
const MLX_EXCLUSION_REASON = "Codex skills use the packaged CLI entrypoint; MCP transport artifacts are not required or distributed by this catalog.";
const DISCOVERY_COMMANDS = {
  gemini: {
    "mlx-agent": "git clone https://github.com/cavi-ai/mlx-agent.git && gemini extensions install ./mlx-agent/providers/gemini",
    "obsidian-agent": "gemini extensions install https://github.com/cavi-ai/obsidian-agent"
  },
  opencode: {
    "mlx-agent": "git clone https://github.com/cavi-ai/mlx-agent.git && python3 mlx-agent/scripts/mlx-agent install opencode --scope user --dry-run --json",
    "obsidian-agent": "git clone https://github.com/cavi-ai/obsidian-agent.git && node obsidian-agent/scripts/install.mjs --host opencode --scope user --dry-run"
  }
};
const LEGACY = new Set(["claude-plugins", "claude-obsidian", "claude-obsidian-plugin"]);
const PROJECTIONS = {
  claude: ".claude-plugin/marketplace.json",
  codex: ".agents/plugins/marketplace.json",
  gemini: "providers/gemini/catalog.json",
  opencode: "providers/opencode/catalog.json"
};
const JSON_FAILURE = Symbol("JSON_FAILURE");

async function json(root, relative, errors) {
  try {
    return JSON.parse(await readFile(path.join(root, relative), "utf8"));
  } catch (error) {
    errors.push(`${relative}: ${error instanceof SyntaxError ? "invalid JSON" : "missing file"}`);
    return JSON_FAILURE;
  }
}

function projectionIdentity(entry) {
  return {
    name: entry?.name,
    repository: entry?.repository ?? entry?.source?.repo,
    package: entry?.package ?? entry?.source?.path ?? "."
  };
}

async function filesUnder(directory, symlinks = [], nonregular = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { symlinks.push(target); return []; }
    if (entry.isDirectory()) return filesUnder(target, symlinks, nonregular);
    if (!entry.isFile()) { nonregular.push(target); return []; }
    return [target];
  }));
  return nested.flat();
}

async function packageTreeHash(packageRoot, included) {
  const hash = createHash("sha256");
  for (const base of included) {
    const files = (await filesUnder(path.join(packageRoot, base))).sort();
    for (const file of files) {
      hash.update(path.relative(packageRoot, file));
      hash.update("\0");
      hash.update(await readFile(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function unknownKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).filter((key) => !allowed.includes(key)) : [];
}

function validateCanonicalSchema(schema, catalog, errors) {
  if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema?.$id !== "https://github.com/cavi-ai/plugins/catalog.schema.json" || schema?.type !== "object" || schema?.additionalProperties !== false || schema?.properties?.name?.const !== MARKETPLACE || schema?.properties?.plugins?.minItems !== 2 || schema?.properties?.plugins?.maxItems !== 2 || schema?.$defs?.plugin?.additionalProperties !== false || JSON.stringify(schema?.$defs?.host?.enum) !== JSON.stringify(HOSTS)) errors.push("catalog schema contract invalid");
  const violation = (location, message) => errors.push(`catalog schema violation: ${location} ${message}`);
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) { violation("root", "must be an object"); return; }
  if (catalog.$schema !== "./catalog.schema.json") errors.push("catalog schema reference invalid");
  for (const key of unknownKeys(catalog, ["$schema", "name", "plugins"])) errors.push(`catalog unknown property: ${key}`);
  if (Object.hasOwn(catalog, "$schema") && typeof catalog.$schema !== "string") violation("$schema", "must be a string");
  if (!Object.hasOwn(catalog, "name")) violation("name", "is required");
  else if (catalog.name !== MARKETPLACE) violation("name", `must equal ${MARKETPLACE}`);
  if (!Object.hasOwn(catalog, "plugins")) violation("plugins", "is required");
  else if (!Array.isArray(catalog.plugins)) violation("plugins", "must be an array");
  else if (catalog.plugins.length !== 2) violation("plugins", "must contain exactly 2 items");
  for (const [index, plugin] of (Array.isArray(catalog.plugins) ? catalog.plugins : []).entries()) {
    const location = `plugins[${index}]`;
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) { violation(location, "must be an object"); continue; }
    for (const key of unknownKeys(plugin, ["name", "repository", "license", "summary", "hosts", "packages"])) errors.push(`catalog plugin ${plugin?.name} unknown property: ${key}`);
    for (const key of ["name", "repository", "license", "summary", "hosts", "packages"]) if (!Object.hasOwn(plugin, key)) violation(`${location}.${key}`, "is required");
    if (Object.hasOwn(plugin, "name") && !REQUIRED.includes(plugin.name)) violation(`${location}.name`, "must be a canonical plugin name");
    if (Object.hasOwn(plugin, "repository") && (typeof plugin.repository !== "string" || !/^cavi-ai\/[a-z0-9-]+$/.test(plugin.repository))) violation(`${location}.repository`, "must match ^cavi-ai/[a-z0-9-]+$");
    for (const key of ["license", "summary"]) if (Object.hasOwn(plugin, key) && (typeof plugin[key] !== "string" || plugin[key].length < 1)) violation(`${location}.${key}`, "must be a non-empty string");
    if (Object.hasOwn(plugin, "hosts")) {
      if (!Array.isArray(plugin.hosts)) violation(`${location}.hosts`, "must be an array");
      else {
        if (plugin.hosts.length !== 5) violation(`${location}.hosts`, "must contain exactly 5 items");
        if (new Set(plugin.hosts.map((host) => JSON.stringify(host))).size !== plugin.hosts.length) violation(`${location}.hosts`, "must contain unique items");
        plugin.hosts.forEach((host, hostIndex) => { if (!HOSTS.includes(host)) violation(`${location}.hosts[${hostIndex}]`, "must be a supported host"); });
      }
    }
    if (!Object.hasOwn(plugin, "packages")) continue;
    if (!plugin.packages || typeof plugin.packages !== "object" || Array.isArray(plugin.packages)) { violation(`${location}.packages`, "must be an object"); continue; }
    for (const key of unknownKeys(plugin.packages, HOSTS)) errors.push(`catalog plugin ${plugin?.name} unknown package host: ${key}`);
    for (const host of HOSTS) {
      if (!Object.hasOwn(plugin.packages, host)) { violation(`${location}.packages.${host}`, "is required"); continue; }
      const pkg = plugin.packages[host];
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) { violation(`${location}.packages.${host}`, "must be an object"); continue; }
      for (const key of unknownKeys(pkg, ["path"])) errors.push(`catalog plugin ${plugin?.name} ${host} package unknown property: ${key}`);
      if (!Object.hasOwn(pkg, "path")) violation(`${location}.packages.${host}.path`, "is required");
      else if (typeof pkg.path !== "string" || pkg.path.length < 1) violation(`${location}.packages.${host}.path`, "must be a non-empty string");
    }
  }
}

function validateTrustedIntegrity(registry, errors) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    errors.push("trusted integrity registry must be an object");
    return;
  }
  for (const name of Object.keys(registry)) if (!REQUIRED.includes(name)) errors.push(`trusted integrity registry unexpected package: ${name}`);
  for (const name of REQUIRED) {
    if (!Object.hasOwn(registry, name)) { errors.push(`trusted integrity registry missing package: ${name}`); continue; }
    const record = registry[name];
    if (!record || typeof record !== "object" || Array.isArray(record)) { errors.push(`trusted integrity ${name} must be an object`); continue; }
    for (const key of unknownKeys(record, ["repository", "source_commit", "source_path", "tree"])) errors.push(`trusted integrity ${name} unexpected property: ${key}`);
    if (record.repository !== `cavi-ai/${name}`) errors.push(`trusted integrity ${name} repository mismatch`);
    if (record.source_commit !== SOURCE_COMMITS[name]) errors.push(`trusted integrity ${name} source_commit mismatch`);
    if (record.source_path !== SOURCE_PATHS[name]) errors.push(`trusted integrity ${name} source_path mismatch`);
    if (typeof record.tree !== "string" || !/^[0-9a-f]{64}$/.test(record.tree)) errors.push(`trusted integrity ${name} tree must be 64 lowercase hexadecimal characters`);
  }
}

function validateNativeProjection(host, projection, errors) {
  const rootAllowed = host === "claude" ? ["name", "owner", "metadata", "plugins"] : ["name", "interface", "plugins"];
  for (const key of unknownKeys(projection, rootAllowed)) errors.push(`${host} native root property invalid: ${key}`);
  if (host === "claude") {
    if (typeof projection?.owner?.name !== "string" || typeof projection?.owner?.url !== "string" || unknownKeys(projection?.owner, ["name", "url"]).length) errors.push("claude native owner invalid");
    if (typeof projection?.metadata?.description !== "string" || unknownKeys(projection?.metadata, ["description"]).length) errors.push("claude native metadata invalid");
  } else if (typeof projection?.interface?.displayName !== "string" || unknownKeys(projection?.interface, ["displayName"]).length) errors.push("codex native interface invalid");
  for (const entry of projection.plugins ?? []) {
    if (host === "claude") {
      if (unknownKeys(entry, ["name", "source", "description"]).length || entry?.source?.source !== "github" || typeof entry?.source?.repo !== "string" || unknownKeys(entry.source, ["source", "repo"]).length) errors.push(`claude native source invalid: ${entry?.name}`);
    } else {
      if (unknownKeys(entry, ["name", "source", "policy", "category"]).length || entry?.source?.source !== "local" || typeof entry?.source?.path !== "string" || unknownKeys(entry.source, ["source", "path"]).length) errors.push(`codex native source invalid: ${entry?.name}`);
      if (entry?.policy?.installation !== "AVAILABLE" || entry?.policy?.authentication !== "ON_INSTALL" || unknownKeys(entry?.policy, ["installation", "authentication"]).length) errors.push(`codex native policy invalid: ${entry?.name}`);
      if (typeof entry?.category !== "string" || !entry.category) errors.push(`codex native category invalid: ${entry?.name}`);
    }
  }
}

async function validateCodexPackage(root, raw, canonical, trustedIntegrity, errors) {
  if (raw?.source?.source !== "local") {
    errors.push(`codex source must be marketplace-local: ${raw?.name}`);
    return;
  }
  const codexPath = canonical.packages?.codex?.path;
  if (typeof codexPath !== "string" || !codexPath) {
    errors.push(`codex package path invalid: ${raw?.name}`);
    return;
  }
  const expected = `./${codexPath}`;
  if (raw.source.path !== expected) errors.push(`codex local source mismatch: ${raw.name}`);
  const packageRoot = path.resolve(root, raw.source.path);
  if (!packageRoot.startsWith(`${path.resolve(root)}${path.sep}`)) {
    errors.push(`codex package escapes catalog: ${raw.name}`);
    return;
  }
  try {
    const rootReal = await realpath(root);
    const packageStat = await lstat(packageRoot);
    if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) { errors.push(`codex package root invalid: ${raw.name}`); return; }
    const packageReal = await realpath(packageRoot);
    if (!packageReal.startsWith(`${rootReal}${path.sep}`)) { errors.push(`codex package realpath escapes catalog: ${raw.name}`); return; }
    const symlinks = [];
    const nonregular = [];
    const packageFiles = await filesUnder(packageRoot, symlinks, nonregular);
    for (const ignored of symlinks) errors.push(`codex package symlink rejected: ${raw.name}`);
    for (const ignored of nonregular) errors.push(`codex package nonregular entry rejected: ${raw.name}`);
    if (symlinks.length || nonregular.length) return;
    const provenance = JSON.parse(await readFile(path.join(packageRoot, "provenance.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(packageRoot, ".codex-plugin/plugin.json"), "utf8"));
    if (manifest.name !== raw.name) errors.push(`codex package manifest mismatch: ${raw.name}`);
    if (provenance.repository !== canonical.repository) errors.push(`codex package provenance repository mismatch: ${raw.name}`);
    if (provenance.source_commit !== SOURCE_COMMITS[raw.name]) errors.push(`codex package source commit mismatch: ${raw.name}`);
    if (provenance.source_path !== SOURCE_PATHS[raw.name]) errors.push(`codex package source path mismatch: ${raw.name}`);
    const provenanceKeys = raw.name === "mlx-agent" ? ["repository", "source_commit", "source_path", "included", "excluded", "exclusion_reason", "integrity"] : ["repository", "source_commit", "source_path", "included", "integrity"];
    if (unknownKeys(provenance, provenanceKeys).length || unknownKeys(provenance.integrity, ["algorithm", "tree"]).length) errors.push(`codex package provenance shape invalid: ${raw.name}`);
    if (raw.name === "mlx-agent" && (JSON.stringify(provenance.excluded) !== JSON.stringify(MLX_EXCLUDED) || provenance.exclusion_reason !== MLX_EXCLUSION_REASON)) errors.push("codex package exclusions mismatch: mlx-agent");
    if (JSON.stringify(provenance.included) !== JSON.stringify(INCLUDED_ROOTS)) errors.push(`codex package included roots mismatch: ${raw.name}`);
    if (!trustedIntegrity || trustedIntegrity.repository !== canonical.repository || trustedIntegrity.source_commit !== SOURCE_COMMITS[raw.name] || trustedIntegrity.source_path !== SOURCE_PATHS[raw.name] || typeof trustedIntegrity.tree !== "string") errors.push(`codex package trusted integrity invalid: ${raw.name}`);
    if (provenance.integrity?.algorithm !== "sha256" || !Array.isArray(provenance.included)) {
      errors.push(`codex package integrity metadata invalid: ${raw.name}`);
    } else if (symlinks.length === 0 && nonregular.length === 0) {
      const actualTree = await packageTreeHash(packageRoot, INCLUDED_ROOTS);
      if (actualTree !== provenance.integrity.tree) errors.push(`codex package integrity mismatch: ${raw.name}`);
      if (actualTree !== trustedIntegrity?.tree) errors.push(`codex package upstream digest mismatch: ${raw.name}`);
    }
    const allowedTop = new Set([".codex-plugin", "skills", "provenance.json"]);
    for (const item of await readdir(packageRoot)) if (!allowedTop.has(item)) errors.push(`codex package unexpected root entry: ${raw.name}: ${item}`);
    const skills = (await readdir(path.join(packageRoot, "skills"), { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
    if (JSON.stringify(skills) !== JSON.stringify(SKILL_INVENTORIES[raw.name])) errors.push(`codex package skill inventory mismatch: ${raw.name}`);
    if (!packageFiles.some((file) => /\/skills\/[^/]+\/SKILL\.md$/.test(file))) errors.push(`codex package has no skills: ${raw.name}`);
    if (packageFiles.some((file) => path.basename(file) === ".mcp.json" || path.basename(file) === "mlx-agent-mcp" || path.basename(file) === "mcp_server.py")) {
      errors.push(`codex package contains MCP transport: ${raw.name}`);
    }
    if (Object.hasOwn(manifest, "mcpServers")) errors.push(`codex package manifest contains mcpServers: ${raw.name}`);
  } catch {
    errors.push(`codex package is incomplete: ${raw.name}`);
  }
}

export async function validateCatalog(root = process.cwd()) {
  const errors = [];
  const catalog = await json(root, "catalog.json", errors);
  const schema = await json(root, "catalog.schema.json", errors);
  const trustedIntegrity = await json(root, "packages/codex/expected-integrity.json", errors);
  if (trustedIntegrity !== JSON_FAILURE) validateTrustedIntegrity(trustedIntegrity, errors);
  const trustedRegistry = trustedIntegrity === JSON_FAILURE ? null : trustedIntegrity;
  if (catalog === JSON_FAILURE) return errors.sort();
  validateCanonicalSchema(schema === JSON_FAILURE ? null : schema, catalog, errors);
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return errors.sort();

  if (catalog.name !== MARKETPLACE) errors.push(`catalog name must be ${MARKETPLACE}`);
  if (!Array.isArray(catalog.plugins)) {
    errors.push("catalog plugins must be an array");
    return errors.sort();
  }

  const byName = new Map();
  for (const [index, plugin] of catalog.plugins.entries()) {
    const prefix = `catalog plugin ${index}`;
    if (!plugin || typeof plugin !== "object") {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (LEGACY.has(plugin.name)) errors.push(`${prefix} uses legacy identity: ${plugin.name}`);
    if (typeof plugin.name !== "string" || !plugin.name) errors.push(`${prefix} name is required`);
    else if (byName.has(plugin.name)) errors.push(`duplicate plugin name: ${plugin.name}`);
    else byName.set(plugin.name, plugin);
    if (typeof plugin.repository !== "string" || !plugin.repository) errors.push(`${prefix} repository is required`);
    else if (plugin.name && plugin.repository !== `cavi-ai/${plugin.name}`) errors.push(`repository identity mismatch: ${plugin.name}`);
    if (typeof plugin.summary !== "string" || !plugin.summary) errors.push(`${prefix} summary is required`);
    if (typeof plugin.license !== "string" || !plugin.license) errors.push(`${prefix} license is required`);
    if (!Array.isArray(plugin.hosts)) errors.push(`${prefix} hosts must be an array`);
    else {
      const seenHosts = new Set();
      for (const host of plugin.hosts) {
        if (seenHosts.has(host)) errors.push(`${prefix} duplicate host: ${host}`);
        seenHosts.add(host);
      }
      for (const host of plugin.hosts) if (!HOSTS.includes(host)) errors.push(`${prefix} unknown host: ${host}`);
      for (const host of HOSTS) if (!seenHosts.has(host)) errors.push(`${prefix} required host missing: ${host}`);
      for (const host of new Set(plugin.hosts.filter((item) => HOSTS.includes(item)))) {
        if (!plugin.packages?.[host]?.path) errors.push(`${prefix} package path missing for host: ${host}`);
      }
    }
  }
  for (const name of REQUIRED) if (!byName.has(name)) errors.push(`required plugin missing: ${name}`);
  for (const name of byName.keys()) if (!REQUIRED.includes(name)) errors.push(`unexpected plugin: ${name}`);

  for (const [host, relative] of Object.entries(PROJECTIONS)) {
    const projection = await json(root, relative, errors);
    if (projection === JSON_FAILURE) continue;
    if (!projection || typeof projection !== "object" || Array.isArray(projection)) { errors.push(`${host} projection must be an object`); continue; }
    if (projection.name !== MARKETPLACE) errors.push(`${host} projection name must be ${MARKETPLACE}`);
    if (host === "claude" || host === "codex") validateNativeProjection(host, projection, errors);
    if (host === "gemini" || host === "opencode") {
      if (projection.host !== host) errors.push(`${host} projection host mismatch`);
      if (projection.protocol !== "discovery") errors.push(`${host} projection must use discovery protocol`);
    }
    if (!Array.isArray(projection.plugins)) {
      errors.push(`${host} projection plugins must be an array`);
      continue;
    }
    const projected = new Set();
    for (const raw of projection.plugins) {
      const entry = projectionIdentity(raw);
      if ((host === "gemini" || host === "opencode") && (typeof raw?.install?.command !== "string" || !raw.install.command.trim())) {
        errors.push(`${host} install command missing: ${entry.name}`);
      }
      if ((host === "gemini" || host === "opencode") && DISCOVERY_COMMANDS[host]?.[entry.name] !== raw?.install?.command) errors.push(`${host} install command mismatch: ${entry.name}`);
      if (projected.has(entry.name)) errors.push(`${host} duplicate projection: ${entry.name}`);
      projected.add(entry.name);
      const canonical = byName.get(entry.name);
      if (!canonical) {
        errors.push(`${host} projects unknown plugin: ${entry.name}`);
        continue;
      }
      if (host === "codex" && raw?.source) {
        await validateCodexPackage(root, raw, canonical, trustedRegistry?.[raw.name], errors);
        entry.repository = canonical.repository;
        entry.package = raw.source.path?.replace(/^\.\//, "");
      }
      if (!canonical.hosts?.includes(host)) errors.push(`${host} projects unsupported plugin host: ${entry.name}`);
      if (entry.repository !== canonical.repository) errors.push(`${host} repository mismatch: ${entry.name}`);
      if (entry.package !== canonical.packages?.[host]?.path) errors.push(`${host} package mismatch: ${entry.name}`);
    }
    for (const plugin of byName.values()) {
      if (plugin.hosts?.includes(host) && !projected.has(plugin.name)) errors.push(`${host} projection missing: ${plugin.name}`);
    }
  }
  return errors.sort();
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const errors = await validateCatalog(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Catalog validation passed.");
  }
}
