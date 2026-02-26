/**
 * `firstclaw register` — Register a new agent in the Agent Family chatroom.
 *
 * Usage:
 *   firstclaw register <category> <displayName> [--id <agentId>] [--nas-root <path>] [--repo-root <path>]
 *
 * Examples:
 *   firstclaw register art "FirstArt02"
 *   firstclaw register publish "FirstGit02" --id git02
 *   firstclaw register dev "FirstDev01" --repo-root /home/user/openclaw
 */

import type { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCanonicalConfigPath } from "../config/paths.js";

const VALID_CATEGORIES = [
  "art",
  "audio",
  "dev",
  "marketing",
  "uiux",
  "publish",
  "orchestrator",
  "other",
] as const;

type Category = (typeof VALID_CATEGORIES)[number];

function deriveAgentId(displayName: string): string {
  return displayName
    .replace(/^First/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function autoDetectRepoRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveNasRoot(cliOverride?: string): string | null {
  if (cliOverride) {
    return cliOverride;
  }

  const configPath = resolveCanonicalConfigPath();
  const cfg = readJsonFile(configPath);
  if (!cfg) {
    return null;
  }

  const plugins = cfg.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const chatroom = entries?.["agent-chatroom"] as Record<string, unknown> | undefined;
  const chatroomConfig = chatroom?.config as Record<string, unknown> | undefined;
  return (chatroomConfig?.nasRoot as string) ?? null;
}

function updateLocalConfig(agentId: string, nasRoot?: string): void {
  const configPath = resolveCanonicalConfigPath();
  let cfg: Record<string, any> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // Config doesn't exist yet — create from scratch
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  if (!cfg.plugins) {
    cfg.plugins = {};
  }
  if (!cfg.plugins.entries) {
    cfg.plugins.entries = {};
  }
  if (!cfg.plugins.entries["agent-chatroom"]) {
    cfg.plugins.entries["agent-chatroom"] = {};
  }
  if (!cfg.plugins.entries["agent-chatroom"].config) {
    cfg.plugins.entries["agent-chatroom"].config = {};
  }

  cfg.plugins.entries["agent-chatroom"].config.agentId = agentId;
  cfg.plugins.entries["agent-chatroom"].config.role = "worker";
  if (nasRoot) {
    cfg.plugins.entries["agent-chatroom"].config.nasRoot = nasRoot;
  }
  cfg.plugins.entries["agent-chatroom"].enabled = true;
}

function updateRepoRoot(repoRoot: string): void {
  const configPath = resolveCanonicalConfigPath();
  let cfg: Record<string, any> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }

  if (!cfg.plugins) {
    cfg.plugins = {};
  }
  if (!cfg.plugins.entries) {
    cfg.plugins.entries = {};
  }
  if (!cfg.plugins.entries["agent-chatroom"]) {
    cfg.plugins.entries["agent-chatroom"] = {};
  }
  if (!cfg.plugins.entries["agent-chatroom"].config) {
    cfg.plugins.entries["agent-chatroom"].config = {};
  }

  cfg.plugins.entries["agent-chatroom"].config.repoRoot = repoRoot;

  writeJsonFile(configPath, cfg);
}

interface RegisterOptions {
  id?: string;
  nasRoot?: string;
  repoRoot?: string;
  force?: boolean;
}

function runRegister(category: string, displayName: string, opts: RegisterOptions): void {
  // Validate category
  if (!VALID_CATEGORIES.includes(category as Category)) {
    console.error(
      `Error: Invalid category "${category}". Valid categories: ${VALID_CATEGORIES.join(", ")}`,
    );
    process.exit(1);
  }

  // Derive or use explicit agent_id
  const agentId = opts.id?.trim() || deriveAgentId(displayName);
  if (!agentId) {
    console.error(`Error: Could not derive agent_id from "${displayName}". Use --id to specify.`);
    process.exit(1);
  }

  // Resolve NAS root
  const nasRoot = resolveNasRoot(opts.nasRoot);
  if (!nasRoot) {
    console.error(
      "Error: Cannot determine NAS root. Either pass --nas-root or configure it in firstclaw.json " +
        '(plugins.entries["agent-chatroom"].config.nasRoot)',
    );
    console.error(
      `\nExample: firstclaw register ${category} "${displayName}" --nas-root /Volumes/Projects`,
    );
    console.error(
      `         firstclaw register ${category} "${displayName}" --nas-root "\\\\FFUS_NAS\\Projects"`,
    );
    process.exit(1);
  }

  // Normalize NAS root: fix broken UNC paths where \\ was reduced to \ by shell escaping
  let normalizedNasRoot = nasRoot;
  if (/^\\[^\\]/.test(normalizedNasRoot)) {
    normalizedNasRoot = "\\" + normalizedNasRoot;
  }
  // Also accept forward-slash UNC (//SERVER/share) and convert to native format
  if (normalizedNasRoot.startsWith("//")) {
    normalizedNasRoot = normalizedNasRoot.replace(/\//g, path.sep);
  }

  const chatroomRoot = path.join(normalizedNasRoot, "chatroom");
  if (!fs.existsSync(chatroomRoot)) {
    console.error(`Error: Chatroom root not found at ${chatroomRoot}. Is the NAS mounted?`);
    console.error(`\nTip: On Windows, try forward slashes to avoid escaping issues:`);
    console.error(`  --nas-root "//FFUS_NAS/Projects"`);
    process.exit(1);
  }

  // Check for duplicate
  const registryDir = path.join(chatroomRoot, "registry");
  const registryPath = path.join(registryDir, `${agentId}.json`);
  if (fs.existsSync(registryPath) && !opts.force) {
    console.error(`Error: Agent "${agentId}" already registered at ${registryPath}`);
    console.error(`Use --force to re-register and repair.`);
    process.exit(1);
  }
  if (opts.force && fs.existsSync(registryPath)) {
    console.log(`  [~] Force mode: overwriting existing registration for "${agentId}"`);
  }

  console.log(`Registering agent: ${displayName} (id: ${agentId}, category: ${category})`);

  // 1. Create registry entry
  fs.mkdirSync(registryDir, { recursive: true });
  const dmChannelId = `dm_${agentId}`;
  const registry = {
    agent_id: agentId,
    display_name: displayName,
    type: "agent",
    status: "offline",
    machine: "",
    last_heartbeat: null,
    channels: ["general", "pipeline", dmChannelId],
    capabilities: [],
    current_task: null,
    category,
  };
  writeJsonFile(registryPath, registry);
  console.log(`  [+] Registry: ${registryPath}`);

  // 2. Create DM channel
  const dmDir = path.join(chatroomRoot, "channels", dmChannelId);
  const dmMsgDir = path.join(dmDir, "messages");
  fs.mkdirSync(dmMsgDir, { recursive: true });
  const dmMeta = {
    channel_id: dmChannelId,
    display_name: `DM: ${displayName}`,
    type: "dm",
    members: ["firstclaw", agentId],
    message_count: 0,
    last_message_seq: 0,
  };
  writeJsonFile(path.join(dmDir, "meta.json"), dmMeta);
  const archivedMarker = path.join(dmDir, ".archived");
  if (fs.existsSync(archivedMarker)) {
    fs.unlinkSync(archivedMarker);
    console.log(`  [~] Removed .archived marker from ${dmChannelId}`);
  }
  console.log(`  [+] DM channel: ${dmChannelId}`);

  // 3. Update channel index
  const indexPath = path.join(chatroomRoot, "channels", "_index.json");
  const index = readJsonFile(indexPath) as { channels?: Array<Record<string, unknown>> } | null;
  if (index?.channels) {
    const exists = index.channels.some((ch) => ch.channel_id === dmChannelId);
    if (!exists) {
      index.channels.push({
        channel_id: dmChannelId,
        display_name: `DM: ${displayName}`,
        type: "dm",
        members: ["firstclaw", agentId],
      });
      writeJsonFile(indexPath, index);
      console.log(`  [+] Channel index updated`);
    }
  }

  // 4. Add agent to general + pipeline channel members
  for (const channelName of ["general", "pipeline"]) {
    const chMetaPath = path.join(chatroomRoot, "channels", channelName, "meta.json");
    const chMeta = readJsonFile(chMetaPath) as { members?: string[] } | null;
    if (chMeta?.members && !chMeta.members.includes(agentId)) {
      chMeta.members.push(agentId);
      writeJsonFile(chMetaPath, chMeta);
      console.log(`  [+] Added to #${channelName}`);
    }
    // Also update the index entry
    if (index?.channels) {
      const entry = index.channels.find((ch) => ch.channel_id === channelName);
      if (entry) {
        const members = entry.members as string[] | undefined;
        if (members && !members.includes(agentId)) {
          members.push(agentId);
        }
      }
    }
  }
  // Write index again if general/pipeline members were updated
  if (index) {
    writeJsonFile(indexPath, index);
  }

  // 5. Update local firstclaw.json
  try {
    updateLocalConfig(agentId, nasRoot);
    console.log(`  [+] Local config: agentId="${agentId}", nasRoot="${nasRoot}"`);
  } catch (err) {
    console.warn(`  [!] Could not update local config: ${err}`);
  }

  // 6. Set repoRoot for auto-update if provided (or auto-detect)
  const effectiveRepoRoot = opts.repoRoot ?? autoDetectRepoRoot();
  if (effectiveRepoRoot) {
    try {
      updateRepoRoot(effectiveRepoRoot);
      console.log(`  [+] Repo root: "${effectiveRepoRoot}"`);
    } catch (err) {
      console.warn(`  [!] Could not set repoRoot in config: ${err}`);
    }
  } else {
    console.log(
      `  [!] repoRoot not set. Auto-update will not work until you run:\n` +
        `      firstclaw config set plugins.entries.agent-chatroom.config.repoRoot /path/to/your/firstclaw/repo`,
    );
  }

  console.log(`\nAgent "${displayName}" registered successfully.`);
  console.log(`  agent_id:  ${agentId}`);
  console.log(`  category:  ${category}`);
  console.log(`  DM channel: ${dmChannelId}`);
  console.log(`\nRestart the gateway to activate: firstclaw gateway restart`);
}

export function registerRegisterCli(program: Command) {
  program
    .command("register")
    .description("Register a new agent in the Agent Family chatroom")
    .argument("<category>", `Agent category (${VALID_CATEGORIES.join(", ")})`)
    .argument("<displayName>", 'Display name (e.g. "FirstArt02")')
    .option("--id <agentId>", "Override auto-derived agent_id")
    .option("--nas-root <path>", "NAS root path (default: from config)")
    .option("--repo-root <path>", "Path to the local FirstClaw git repo (auto-detected if omitted)")
    .option("--force", "Re-register even if agent already exists (repairs partial registrations)")
    .action((category: string, displayName: string, opts: RegisterOptions) => {
      runRegister(category, displayName, opts);
    });
}
