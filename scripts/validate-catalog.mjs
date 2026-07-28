#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOSTS = ["claude", "codex", "gemini", "opencode", "agentskills"];
const REQUIRED = ["mlx-agent", "obsidian-agent"];
const LEGACY = new Set(["claude-plugins", "claude-obsidian", "claude-obsidian-plugin"]);
const PROJECTIONS = {
  claude: ".claude-plugin/marketplace.json",
  codex: ".agents/plugins/marketplace.json",
  gemini: "providers/gemini/catalog.json",
  opencode: "providers/opencode/catalog.json"
};

async function json(root, relative, errors) {
  try {
    return JSON.parse(await readFile(path.join(root, relative), "utf8"));
  } catch (error) {
    errors.push(`${relative}: ${error instanceof SyntaxError ? "invalid JSON" : "missing file"}`);
    return null;
  }
}

function projectionIdentity(entry) {
  return {
    name: entry?.name,
    repository: entry?.repository ?? entry?.source?.repo,
    package: entry?.package ?? entry?.source?.path ?? "."
  };
}

export async function validateCatalog(root = process.cwd()) {
  const errors = [];
  const catalog = await json(root, "catalog.json", errors);
  await json(root, "catalog.schema.json", errors);
  if (!catalog) return errors.sort();

  if (catalog.name !== "plugins") errors.push("catalog name must be plugins");
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
    if (!projection) continue;
    if (projection.name !== "plugins") errors.push(`${host} projection name must be plugins`);
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
      if (projected.has(entry.name)) errors.push(`${host} duplicate projection: ${entry.name}`);
      projected.add(entry.name);
      const canonical = byName.get(entry.name);
      if (!canonical) {
        errors.push(`${host} projects unknown plugin: ${entry.name}`);
        continue;
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
