/**
 * `firstclaw register` — Register a new agent in the Agent Family chatroom.
 *
 * Usage:
 *   firstclaw register <category> <displayName> [--id <agentId>] [--nas-root <path>]
 *
 * Examples:
 *   firstclaw register art "FirstArt02"
 *   firstclaw register publish "FirstGit02" --id git02
 */

import type { Command } from "commander";
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

function updateLocalConfig(agentId: string): void {
  const configPath = resolveCanonicalConfigPath();
  const raw = fs.readFileSync(configPath, "utf-8");
  const cfg = JSON.parse(raw);

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

  if (!cfg.plugins.entries["agent-chatroom"].enabled) {
    cfg.plugins.entries["agent-chatroom"].enabled = true;
  }

  writeJsonFile(configPath, cfg);
}

interface RegisterOptions {
  id?: string;
  nasRoot?: string;
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
    process.exit(1);
  }

  const chatroomRoot = path.join(nasRoot, "chatroom");
  if (!fs.existsSync(chatroomRoot)) {
    console.error(`Error: Chatroom root not found at ${chatroomRoot}. Is the NAS mounted?`);
    process.exit(1);
  }

  // Check for duplicate
  const registryDir = path.join(chatroomRoot, "registry");
  const registryPath = path.join(registryDir, `${agentId}.json`);
  if (fs.existsSync(registryPath)) {
    console.error(`Error: Agent "${agentId}" already registered at ${registryPath}`);
    process.exit(1);
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
    updateLocalConfig(agentId);
    console.log(`  [+] Local config: agentId set to "${agentId}"`);
  } catch (err) {
    console.warn(`  [!] Could not update local config: ${err}`);
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
    .action((category: string, displayName: string, opts: RegisterOptions) => {
      runRegister(category, displayName, opts);
    });
}
