/**
 * Agent Chatroom Plugin for FirstClaw / OpenClaw
 *
 * Provides:
 *   1. Tools for LLM agents to interact with the multi-agent chatroom.
 *   2. A background daemon that polls the NAS inbox and **automatically
 *      dispatches** incoming messages through the LLM.
 *   3. A reliable **Task Dispatch Protocol** with system-level ACK handshake:
 *
 *        Orchestrator                Target Agent
 *             │                           │
 *             │── TASK_DISPATCH ─────────>│  ① assign task
 *             │                           │
 *             │<── TASK_ACK (system) ─────│  ② instant ACK (no LLM)
 *             │                           │
 *             │    [LLM processes task]   │
 *             │                           │
 *             │<── RESULT_REPORT ─────────│  ③ deliver result
 *             │                           │
 */

import type { FirstClawPluginApi } from "firstclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { createReplyPrefixContext, type ReplyPayload } from "firstclaw/plugin-sdk";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

interface ChatroomConfig {
  nasRoot: string;
  agentId: string;
  localDir: string;
  role: "orchestrator" | "worker";
}

interface AgentRegistryEntry {
  agent_id: string;
  display_name: string;
  type: string;
  status: string;
  channels: string[];
}

interface InboxMessage {
  message_id: string;
  channel_id: string;
  from: string;
  type: string;
  content: { text: string; mentions: string[] };
  timestamp: string;
  seq: number;
  metadata?: Record<string, any>;
}

type TaskStatus =
  | "DISPATCHED"
  | "ACKED"
  | "PROCESSING"
  | "DONE"
  | "FAILED"
  | "TIMEOUT"
  | "ABANDONED"
  | "CANCELLED"
  | "RETRYING"
  | "PARKED";

type TaskErrorType = "CONTEXT_OVERFLOW" | "RATE_LIMITED" | "LLM_ERROR" | "TOOL_ERROR";

interface ProgressEntry {
  timestamp: string;
  phase: string;
  detail?: string;
}

interface TaskRecord {
  task_id: string;
  from: string;
  to: string;
  channel_id: string;
  status: TaskStatus;
  instruction: string;
  dispatched_at: string;
  acked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
  asset_paths: string[];
  retries: number;
  max_retries: number;
  ack_timeout_ms: number;
  task_timeout_ms: number;
  error_type?: TaskErrorType | null;
  error_detail?: string | null;
  progress_log?: ProgressEntry[];
  current_phase?: string | null;
}

type ParkWatchType = "shell" | "file" | "poll_url" | "permission";

interface ParkedTaskInfo {
  task_id: string;
  agent_id: string;
  channel_id: string;
  original_instruction: string;
  resume_prompt: string;
  watch_type: ParkWatchType;
  watch_config: {
    command?: string;
    file_path?: string;
    url?: string;
    expected_status?: number;
    permission_id?: string;
  };
  poll_interval_ms: number;
  max_wait_ms: number;
  parked_at: string;
  last_poll_at: string | null;
  poll_count: number;
}

interface PermissionRecord {
  permission_id: string;
  task_id: string;
  agent_id: string;
  channel_id: string;
  status: "pending" | "approved" | "rejected" | "allowlisted";
  operation: {
    type: string;
    command?: string;
    path?: string;
    url?: string;
    pattern: string;
    working_dir?: string;
  };
  summary: string;
  context_snapshot: {
    original_instruction: string;
    resume_prompt: string;
  };
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision: string | null;
  decision_reason: string | null;
}

interface Logger {
  info: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  error: (...a: any[]) => void;
}

// ============================================================================
// NAS file helpers
// ============================================================================

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: any): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function randomUUID(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

// ============================================================================
// File lock
// ============================================================================

function acquireLock(lockPath: string, holder: string, timeoutSec = 30, retries = 5): boolean {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, JSON.stringify({ holder, timestamp: nowISO(), expires: timeoutSec }));
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const lock = readJson(lockPath);
        if (lock?.timestamp) {
          const age = (Date.now() - new Date(lock.timestamp).getTime()) / 1000;
          if (age > timeoutSec) {
            fs.unlinkSync(lockPath);
            continue;
          }
        }
      } catch {
        /* ignore */
      }
      if (i < retries - 1) {
        const start = Date.now();
        while (Date.now() - start < 1000) {
          /* busy wait */
        }
      }
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Core chatroom operations
// ============================================================================

function chatroomRoot(cfg: ChatroomConfig): string {
  return path.join(cfg.nasRoot, "chatroom");
}

function tasksDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "tasks");
}

function assetsDir(cfg: ChatroomConfig, agentId?: string): string {
  const base = path.join(chatroomRoot(cfg), "assets");
  return agentId ? path.join(base, agentId) : base;
}

function taskAssetsDir(cfg: ChatroomConfig, agentId: string, taskId: string): string {
  return path.join(assetsDir(cfg, agentId), taskId);
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

function scanOutputDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) files.push(toForwardSlash(path.join(dir, entry.name)));
  }
  return files;
}

// ============================================================================
// Permission helpers
// ============================================================================

function permissionsDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "permissions");
}

function permissionAllowlistPath(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "config", "permission_allowlist.json");
}

function writePermissionRecord(cfg: ChatroomConfig, record: PermissionRecord): void {
  const dir = permissionsDir(cfg);
  ensureDir(dir);
  writeJson(path.join(dir, `${record.permission_id}.json`), record);
}

function readPermissionRecord(cfg: ChatroomConfig, permissionId: string): PermissionRecord | null {
  return readJson(path.join(permissionsDir(cfg), `${permissionId}.json`));
}

function readAllowlist(cfg: ChatroomConfig): {
  patterns: Array<{ pattern: string; added_by: string; added_at: string }>;
} {
  const data = readJson(permissionAllowlistPath(cfg));
  return data?.patterns ? data : { patterns: [] };
}

function buildOperationPattern(opType: string, opDetail: string): string {
  const typeName = opType.charAt(0).toUpperCase() + opType.slice(1);
  if (opType === "shell") {
    const cmd = opDetail.split(/\s+/)[0] ?? opDetail;
    return `${typeName}(${cmd}:*)`;
  }
  // For file operations, create a directory-level glob
  const normalized = opDetail.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dirPart = lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
  return `${typeName}(${dirPart}/**)`;
}

function matchesAllowlist(cfg: ChatroomConfig, opType: string, opDetail: string): boolean {
  const allowlist = readAllowlist(cfg);
  if (allowlist.patterns.length === 0) return false;

  const typeName = opType.charAt(0).toUpperCase() + opType.slice(1);

  for (const entry of allowlist.patterns) {
    const pat = entry.pattern;
    // Parse pattern: Type(glob)
    const match = pat.match(/^(\w+)\((.+)\)$/);
    if (!match) continue;
    const [, patType, patGlob] = match;
    if (patType !== typeName) continue;

    if (opType === "shell") {
      // Shell patterns: "Shell(cmd:argGlob)" or "Shell(cmd:*)"
      const colonIdx = patGlob.indexOf(":");
      if (colonIdx === -1) {
        // Simple command match: Shell(git)
        const cmd = opDetail.split(/\s+/)[0] ?? "";
        if (cmd === patGlob) return true;
      } else {
        const patCmd = patGlob.slice(0, colonIdx);
        const patArgGlob = patGlob.slice(colonIdx + 1);
        const cmd = opDetail.split(/\s+/)[0] ?? "";
        if (cmd !== patCmd) continue;
        if (patArgGlob === "*") return true;
        // Simple prefix match for arg patterns
        const args = opDetail.slice(cmd.length).trim();
        const argPrefix = patArgGlob.replace(/\*+$/, "");
        if (args.startsWith(argPrefix)) return true;
      }
    } else {
      // File/network patterns: glob matching on paths
      const normalized = opDetail.replace(/\\/g, "/");
      const globPrefix = patGlob.replace(/\*+$/, "");
      if (normalized.startsWith(globPrefix)) return true;
    }
  }
  return false;
}

function createPermissionRequest(
  cfg: ChatroomConfig,
  taskId: string,
  agentId: string,
  channelId: string,
  opType: string,
  opDetail: string,
  summary: string,
  originalInstruction: string,
  resumePrompt: string,
  logger: Logger,
): PermissionRecord {
  const permissionId = randomUUID();
  const pattern = buildOperationPattern(opType, opDetail);

  const operation: PermissionRecord["operation"] = {
    type: opType,
    pattern,
  };
  if (opType === "shell") operation.command = opDetail;
  else if (opType === "write" || opType === "read") operation.path = opDetail;
  else if (opType === "network") operation.url = opDetail;
  else operation.command = opDetail;

  const record: PermissionRecord = {
    permission_id: permissionId,
    task_id: taskId,
    agent_id: agentId,
    channel_id: channelId,
    status: "pending",
    operation,
    summary,
    context_snapshot: {
      original_instruction: originalInstruction,
      resume_prompt: resumePrompt,
    },
    requested_at: nowISO(),
    decided_at: null,
    decided_by: null,
    decision: null,
    decision_reason: null,
  };

  writePermissionRecord(cfg, record);

  // Post PERMISSION_REQUEST message to #permission channel
  const msgText = [
    `**Permission Required** for task \`${taskId.slice(0, 8)}...\``,
    `**Agent:** ${agentId}`,
    `**Operation:** \`${opDetail}\``,
    ``,
    summary,
  ].join("\n");

  sendMessageToNAS(cfg, "permission", msgText, "PERMISSION_REQUEST", [], undefined, {
    permission_id: permissionId,
    permission_status: "pending",
    permission_operation: operation,
    permission_summary: summary,
    task_id: taskId,
  });

  logger.info(
    `Permission request ${permissionId} created for task ${taskId} (${opType}: ${opDetail.slice(0, 60)})`,
  );
  return record;
}

function readAgentRegistry(cfg: ChatroomConfig): AgentRegistryEntry[] {
  const regDir = path.join(chatroomRoot(cfg), "registry");
  if (!fs.existsSync(regDir)) return [];
  const agents: AgentRegistryEntry[] = [];
  for (const file of fs.readdirSync(regDir)) {
    if (!file.endsWith(".json")) continue;
    const data = readJson(path.join(regDir, file));
    if (data?.agent_id) agents.push(data);
  }
  return agents;
}

function parseAtMentions(text: string): string[] {
  const matches = text.match(/@(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

function sendMessageToNAS(
  cfg: ChatroomConfig,
  channelId: string,
  text: string,
  msgType: string = "CHAT",
  mentions: string[] = [],
  replyTo?: string,
  metadata?: Record<string, any>,
): { message_id: string; seq: number } {
  const root = chatroomRoot(cfg);
  const chDir = path.join(root, "channels", channelId);
  const msgDir = path.join(chDir, "messages");
  const metaPath = path.join(chDir, "meta.json");
  const lockPath = path.join(chDir, ".lock");

  ensureDir(msgDir);

  if (!acquireLock(lockPath, cfg.agentId)) {
    throw new Error(`Failed to acquire lock for channel ${channelId}`);
  }

  try {
    const meta = readJson(metaPath) ?? { last_message_seq: 0, message_count: 0 };
    const seq = (meta.last_message_seq ?? 0) + 1;
    const messageId = randomUUID();
    const timestamp = nowISO();
    const tsCompact = timestamp.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("T", "T");

    const msg = {
      message_id: messageId,
      seq,
      timestamp,
      channel_id: channelId,
      from: cfg.agentId,
      type: msgType,
      content: { text, mentions, attachments: [] },
      reply_to: replyTo ?? null,
      metadata: { priority: "normal", ...(metadata ?? {}) },
    };

    const filename = `${String(seq).padStart(6, "0")}_${tsCompact}_${messageId}.json`;
    writeJson(path.join(msgDir, filename), msg);

    meta.last_message_seq = seq;
    meta.message_count = (meta.message_count ?? 0) + 1;
    writeJson(metaPath, meta);

    const members: string[] = meta.members ?? [];
    const notifySet = new Set(members);
    for (const m of mentions) notifySet.add(m);
    notifySet.delete(cfg.agentId);

    for (const target of notifySet) {
      const isMentioned = mentions.includes(target);
      const inboxDir = path.join(root, "inbox", target);
      ensureDir(inboxDir);
      const notif = {
        notification_id: randomUUID(),
        timestamp,
        channel_id: channelId,
        message_seq: seq,
        from: cfg.agentId,
        preview: text.slice(0, 120),
        priority: isMentioned ? "high" : "normal",
        mentioned: isMentioned,
      };
      writeJson(
        path.join(inboxDir, `${String(seq).padStart(6, "0")}_${notif.notification_id}.json`),
        notif,
      );
    }

    return { message_id: messageId, seq };
  } finally {
    releaseLock(lockPath);
  }
}

function listAgentChannels(cfg: ChatroomConfig): any[] {
  const indexPath = path.join(chatroomRoot(cfg), "channels", "_index.json");
  const idx = readJson(indexPath);
  if (!idx?.channels) return [];
  return idx.channels.filter(
    (ch: any) => Array.isArray(ch.members) && ch.members.includes(cfg.agentId),
  );
}

function updateHeartbeat(cfg: ChatroomConfig): void {
  const regPath = path.join(chatroomRoot(cfg), "registry", `${cfg.agentId}.json`);
  const info = readJson(regPath);
  if (!info) return;
  info.last_heartbeat = nowISO();
  if (info.status === "offline") info.status = "idle";
  writeJson(regPath, info);
}

// ============================================================================
// Self-update: git pull → exit(42) → run-node.mjs handles install + build + relaunch
// ============================================================================

const SELF_UPDATE_EXIT_CODE = 42;
const UPGRADE_CHANNEL_ID = "upgrade";
const SELF_UPDATE_MARKER = ".self-update-pending.json";

function resolveGitRoot(): string | null {
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

function resolveProjectRoot(): string {
  return resolveGitRoot() ?? process.cwd();
}

function readProjectVersion(): string {
  const root = resolveProjectRoot();
  const buildInfo = readJson(path.join(root, "dist", "build-info.json"));
  if (buildInfo?.version) return buildInfo.version;
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg?.version) return pkg.version;
  return "unknown";
}

function readProjectCommit(): string {
  const root = resolveProjectRoot();
  const buildInfo = readJson(path.join(root, "dist", "build-info.json"));
  if (buildInfo?.commit) return String(buildInfo.commit).slice(0, 8);
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: root,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function writeSelfUpdateMarker(cfg: ChatroomConfig, requestedBy: string): void {
  const markerPath = path.join(resolveProjectRoot(), SELF_UPDATE_MARKER);
  writeJson(markerPath, {
    agent_id: cfg.agentId,
    previous_version: readProjectVersion(),
    requested_by: requestedBy,
    timestamp: nowISO(),
  });
}

function readAndClearSelfUpdateMarker(): {
  agent_id: string;
  previous_version: string;
  requested_by: string;
  timestamp: string;
} | null {
  const markerPath = path.join(resolveProjectRoot(), SELF_UPDATE_MARKER);
  const data = readJson(markerPath);
  if (!data) return null;
  try {
    fs.unlinkSync(markerPath);
  } catch {
    /* ignore */
  }
  return data;
}

function ensureUpgradeChannel(cfg: ChatroomConfig): void {
  const root = chatroomRoot(cfg);
  const indexPath = path.join(root, "channels", "_index.json");
  const idx = readJson(indexPath);
  if (!idx?.channels) return;

  let upgradeChannel = idx.channels.find((ch: any) => ch.channel_id === UPGRADE_CHANNEL_ID);

  if (!upgradeChannel) {
    const allAgents = readAgentRegistry(cfg).map((a) => a.agent_id);
    if (!allAgents.includes(cfg.agentId)) allAgents.push(cfg.agentId);
    upgradeChannel = {
      channel_id: UPGRADE_CHANNEL_ID,
      display_name: "#upgrade",
      type: "group",
      members: allAgents,
    };
    idx.channels.push(upgradeChannel);
    writeJson(indexPath, idx);
  } else if (!upgradeChannel.members?.includes(cfg.agentId)) {
    upgradeChannel.members.push(cfg.agentId);
    writeJson(indexPath, idx);
  }

  const chDir = path.join(root, "channels", UPGRADE_CHANNEL_ID);
  ensureDir(path.join(chDir, "messages"));
  const metaPath = path.join(chDir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    writeJson(metaPath, upgradeChannel);
  } else {
    const meta = readJson(metaPath);
    if (meta && !meta.members?.includes(cfg.agentId)) {
      meta.members.push(cfg.agentId);
      writeJson(metaPath, meta);
    }
  }
}

function pauseActiveTasksForUpgrade(cfg: ChatroomConfig, logger: Logger): number {
  const activeTasks = listTasksByStatus(cfg, "DISPATCHED", "ACKED", "PROCESSING");
  const myTasks = activeTasks.filter((t) => t.to === cfg.agentId || t.from === cfg.agentId);
  for (const task of myTasks) {
    updateTaskRecord(cfg, task.task_id, {
      status: "PARKED",
      current_phase: "system_upgrade",
    } as Partial<TaskRecord>);
    logger.info(`[self-update] Parked task ${task.task_id} (was ${task.status})`);
  }
  return myTasks.length;
}

function isSelfUpdateCommand(msg: InboxMessage): boolean {
  if (msg.metadata?.system_command === "self_update") return true;
  const text = msg.content?.text?.trim() ?? "";
  if (/^\/system-update\b/i.test(text)) return true;
  // #upgrade is a dedicated channel: any non-report message is an update trigger
  if (msg.channel_id === UPGRADE_CHANNEL_ID && msg.type !== "STATUS_UPDATE") return true;
  return false;
}

function isSelfUpdateAuthorized(msg: InboxMessage): boolean {
  const from = msg.from ?? "";
  if (from.startsWith("human:")) return true;
  if (from === "firstclaw") return true;
  if (msg.metadata?.system_command === "self_update") return true;
  return false;
}

function reportVersionToUpgrade(cfg: ChatroomConfig, extra?: string): void {
  ensureUpgradeChannel(cfg);
  const version = readProjectVersion();
  const commit = readProjectCommit();
  let text = `[${cfg.agentId}] Current version: v${version} (${commit})`;
  if (extra) text += `\n${extra}`;
  sendMessageToNAS(cfg, UPGRADE_CHANNEL_ID, text, "STATUS_UPDATE");
}

async function handleSelfUpdate(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  logger: Logger,
): Promise<void> {
  const projectRoot = resolveProjectRoot();
  logger.info(
    `[self-update] Received update command from ${msg.from} in #${msg.channel_id} (root: ${projectRoot})`,
  );

  ensureUpgradeChannel(cfg);

  const sendStatus = (text: string) => {
    try {
      sendMessageToNAS(cfg, UPGRADE_CHANNEL_ID, text, "STATUS_UPDATE");
    } catch (err) {
      logger.warn(`[self-update] Failed to send status: ${err}`);
    }
  };

  try {
    logger.info("[self-update] Running git pull...");
    const pullOutput = execSync("git pull --ff-only", {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 60_000,
    }).trim();
    logger.info(`[self-update] git pull: ${pullOutput}`);

    if (pullOutput === "Already up to date.") {
      reportVersionToUpgrade(cfg, "Already up to date.");
      return;
    }

    const parkedCount = pauseActiveTasksForUpgrade(cfg, logger);
    const parkedNote = parkedCount > 0 ? ` (${parkedCount} active task(s) parked)` : "";

    writeSelfUpdateMarker(cfg, msg.from);

    sendStatus(`[${cfg.agentId}] Code pulled. Shutting down for rebuild & restart...${parkedNote}`);
    logger.info(
      "[self-update] Code pulled. Exiting with code 42 — run-node.mjs will install, build, and relaunch.",
    );

    await new Promise((r) => setTimeout(r, 500));
    process.exit(SELF_UPDATE_EXIT_CODE);
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? "";
    const stdout = err.stdout?.toString?.() ?? "";
    const detail = stderr || stdout || err.message || String(err);
    logger.error(`[self-update] Update failed: ${detail}`);
    sendStatus(`[${cfg.agentId}] Update failed:\n${detail.slice(0, 500)}`);
  }
}

function pollInbox(cfg: ChatroomConfig): InboxMessage[] {
  const root = chatroomRoot(cfg);
  const inboxDir = path.join(root, "inbox", cfg.agentId);
  if (!fs.existsSync(inboxDir)) return [];

  const files = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const messages: InboxMessage[] = [];

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    try {
      const notif = readJson(filePath);
      if (!notif) continue;

      let resolved = false;

      // Try to read the original message from the channel
      if (notif.message_seq && notif.message_seq > 0) {
        const msgDir = path.join(root, "channels", notif.channel_id, "messages");
        if (fs.existsSync(msgDir)) {
          const prefix = String(notif.message_seq).padStart(6, "0");
          const msgFiles = fs.readdirSync(msgDir).filter((f) => f.startsWith(prefix));
          if (msgFiles.length > 0) {
            const fullMsg = readJson(path.join(msgDir, msgFiles[0]));
            if (fullMsg) {
              messages.push(fullMsg);
              resolved = true;
            }
          }
        }
      }

      // Fallback: retry notifications or missing message files — construct
      // a synthetic InboxMessage from the notification itself so it can still
      // be routed (e.g. as a TASK_DISPATCH retry).
      if (!resolved && notif.retry_for_task) {
        const taskData = readJson(path.join(tasksDir(cfg), `${notif.retry_for_task}.json`));
        if (taskData) {
          messages.push({
            message_id: notif.notification_id ?? randomUUID(),
            channel_id: notif.channel_id,
            from: notif.from ?? taskData.from,
            type: "TASK_DISPATCH",
            content: {
              text: taskData.instruction ?? notif.preview ?? "",
              mentions: [cfg.agentId],
            },
            timestamp: notif.timestamp ?? nowISO(),
            seq: 0,
            metadata: {
              task_id: notif.retry_for_task,
              priority: "urgent",
              output_dir: taskData.asset_paths?.[0]
                ? path.dirname(taskData.asset_paths[0])
                : taskAssetsDir(cfg, cfg.agentId, notif.retry_for_task),
              is_retry: true,
            },
          });
          resolved = true;
        }
      }

      // Fallback: construct minimal message from notification preview
      if (!resolved && notif.preview) {
        messages.push({
          message_id: notif.notification_id ?? randomUUID(),
          channel_id: notif.channel_id,
          from: notif.from ?? "unknown",
          type: "CHAT",
          content: {
            text: notif.preview,
            mentions: notif.mentioned ? [cfg.agentId] : [],
          },
          timestamp: notif.timestamp ?? nowISO(),
          seq: notif.message_seq ?? 0,
          metadata: {},
        });
      }

      fs.unlinkSync(filePath);
    } catch {
      /* skip */
    }
  }

  return messages;
}

// ============================================================================
// Task Registry — persistent task state on NAS
// ============================================================================

function createTaskRecord(
  cfg: ChatroomConfig,
  to: string,
  channelId: string,
  instruction: string,
  opts?: { ackTimeoutMs?: number; taskTimeoutMs?: number; maxRetries?: number },
): TaskRecord {
  const dir = tasksDir(cfg);
  ensureDir(dir);

  const task: TaskRecord = {
    task_id: randomUUID(),
    from: cfg.agentId,
    to,
    channel_id: channelId,
    status: "DISPATCHED",
    instruction,
    dispatched_at: nowISO(),
    acked_at: null,
    started_at: null,
    completed_at: null,
    result_summary: null,
    asset_paths: [],
    retries: 0,
    max_retries: opts?.maxRetries ?? 3,
    ack_timeout_ms: opts?.ackTimeoutMs ?? 60_000,
    task_timeout_ms: opts?.taskTimeoutMs ?? 3_600_000,
  };

  writeJson(path.join(dir, `${task.task_id}.json`), task);
  return task;
}

function readTaskRecord(cfg: ChatroomConfig, taskId: string): TaskRecord | null {
  return readJson(path.join(tasksDir(cfg), `${taskId}.json`));
}

function updateTaskRecord(cfg: ChatroomConfig, taskId: string, patch: Partial<TaskRecord>): void {
  const filePath = path.join(tasksDir(cfg), `${taskId}.json`);
  const existing = readJson(filePath);
  if (!existing) return;
  writeJson(filePath, { ...existing, ...patch });
}

function listTasksByStatus(cfg: ChatroomConfig, ...statuses: TaskStatus[]): TaskRecord[] {
  const dir = tasksDir(cfg);
  if (!fs.existsSync(dir)) return [];

  const statusSet = new Set(statuses);
  const tasks: TaskRecord[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const task = readJson(path.join(dir, file)) as TaskRecord | null;
    if (task && statusSet.has(task.status)) tasks.push(task);
  }
  return tasks;
}

// ============================================================================
// Task Protocol: dispatch, ACK, result
// ============================================================================

function dispatchTask(
  cfg: ChatroomConfig,
  to: string,
  instruction: string,
  logger: Logger,
  opts?: { ackTimeoutMs?: number; taskTimeoutMs?: number; maxRetries?: number },
): TaskRecord {
  const channelId = `dm_${to}`;
  const task = createTaskRecord(cfg, to, channelId, instruction, opts);

  const outputDir = taskAssetsDir(cfg, to, task.task_id);
  ensureDir(outputDir);

  sendMessageToNAS(cfg, channelId, instruction, "TASK_DISPATCH", [to], undefined, {
    task_id: task.task_id,
    priority: "urgent",
    output_dir: outputDir,
    task_timeout_ms: task.task_timeout_ms,
  });

  logger.info(`Task ${task.task_id} dispatched to ${to} via #${channelId} (output: ${outputDir})`);
  return task;
}

function sendSystemAck(cfg: ChatroomConfig, task: TaskRecord, logger: Logger): void {
  const ackText = `[SYSTEM] Task ${task.task_id} acknowledged by ${cfg.agentId}`;
  sendMessageToNAS(cfg, task.channel_id, ackText, "TASK_ACK", [task.from], undefined, {
    task_id: task.task_id,
  });
  updateTaskRecord(cfg, task.task_id, { status: "ACKED", acked_at: nowISO() });
  logger.info(`ACK sent for task ${task.task_id} → ${task.from}`);
}

function sendTaskResult(
  cfg: ChatroomConfig,
  taskId: string,
  resultText: string,
  status: "DONE" | "FAILED",
  logger: Logger,
  assetPaths: string[] = [],
  errorType?: TaskErrorType | null,
): void {
  finalizeTaskProgress(cfg, taskId);

  const task = readTaskRecord(cfg, taskId);
  if (!task) {
    logger.warn(`Cannot send result — task ${taskId} not found`);
    return;
  }
  sendMessageToNAS(cfg, task.channel_id, resultText, "RESULT_REPORT", [task.from], undefined, {
    task_id: taskId,
    status,
    asset_paths: assetPaths,
    error_type: errorType ?? undefined,
  });
  const patch: Partial<TaskRecord> = {
    status,
    completed_at: nowISO(),
    result_summary: resultText.slice(0, 500),
    asset_paths: assetPaths,
  };
  if (errorType) {
    patch.error_type = errorType;
    patch.error_detail = resultText.slice(0, 2000);
  }
  patch.current_phase = status === "DONE" ? "completed" : "failed";
  updateTaskRecord(cfg, taskId, patch);
  resetAgentStatus(cfg, task.to, logger);
  logger.info(
    `Result sent for task ${taskId} (${status}${errorType ? ` [${errorType}]` : ""}) → ${task.from}`,
  );
}

function cancelTask(
  cfg: ChatroomConfig,
  taskId: string,
  reason: string,
  logger: Logger,
): TaskRecord | null {
  const task = readTaskRecord(cfg, taskId);
  if (!task) return null;

  const terminalStatuses: TaskStatus[] = ["DONE", "FAILED", "ABANDONED", "CANCELLED"];
  if (terminalStatuses.includes(task.status)) return task;

  updateTaskRecord(cfg, taskId, {
    status: "CANCELLED",
    completed_at: nowISO(),
    result_summary: `Cancelled: ${reason}`.slice(0, 500),
  });

  sendMessageToNAS(
    cfg,
    task.channel_id,
    `[SYSTEM] Task ${taskId} cancelled by ${cfg.agentId}. Reason: ${reason}`,
    "SYSTEM",
    [task.to],
    undefined,
    { task_id: taskId, status: "CANCELLED" },
  );

  resetAgentStatus(cfg, task.to, logger);
  logger.info(`Task ${taskId} cancelled (was ${task.status}) → ${task.to}`);
  return { ...task, status: "CANCELLED", completed_at: nowISO() };
}

function setAgentWorking(
  cfg: ChatroomConfig,
  agentId: string,
  taskId: string,
  logger: Logger,
): void {
  const regPath = path.join(chatroomRoot(cfg), "registry", `${agentId}.json`);
  const info = readJson(regPath);
  if (!info) return;
  info.status = "working";
  info.current_task = taskId;
  info.last_heartbeat = nowISO();
  writeJson(regPath, info);
  logger.info(`Agent ${agentId} status → working (task: ${taskId.slice(0, 8)})`);
}

function resetAgentStatus(cfg: ChatroomConfig, agentId: string, logger: Logger): void {
  const regPath = path.join(chatroomRoot(cfg), "registry", `${agentId}.json`);
  const info = readJson(regPath);
  if (!info) return;
  if (info.status === "working" || info.status === "waiting") {
    info.status = "idle";
    info.current_task = null;
    writeJson(regPath, info);
    logger.info(`Reset ${agentId} status to idle`);
  }
}

// ============================================================================
// Error classification
// ============================================================================

const ERROR_PATTERNS: Array<{ type: TaskErrorType; patterns: RegExp[] }> = [
  {
    type: "CONTEXT_OVERFLOW",
    patterns: [
      /context overflow/i,
      /prompt too large/i,
      /compaction.?fail/i,
      /context.?window.?too small/i,
      /maximum context length/i,
      /token limit/i,
    ],
  },
  {
    type: "RATE_LIMITED",
    patterns: [
      /rate.?limit/i,
      /too many requests/i,
      /\b429\b/,
      /resource.?exhausted/i,
      /quota.?exceeded/i,
      /throttl/i,
    ],
  },
  {
    type: "TOOL_ERROR",
    patterns: [/tool.+(?:fail|error)/i, /(?:fail|error).+tool/i, /tool execution/i],
  },
];

function classifyError(text: string): TaskErrorType {
  for (const { type, patterns } of ERROR_PATTERNS) {
    for (const re of patterns) {
      if (re.test(text)) return type;
    }
  }
  return "LLM_ERROR";
}

// ============================================================================
// Task progress tracking (buffered NAS writes)
// ============================================================================

const _progressBuffers = new Map<
  string,
  { entries: ProgressEntry[]; phase: string; flushTimer: ReturnType<typeof setTimeout> | null }
>();

const PROGRESS_FLUSH_INTERVAL_MS = 5_000;

function _flushProgress(cfg: ChatroomConfig, taskId: string): void {
  const buf = _progressBuffers.get(taskId);
  if (!buf || buf.entries.length === 0) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  const existing = task.progress_log ?? [];
  const merged = [...existing, ...buf.entries];
  updateTaskRecord(cfg, taskId, {
    progress_log: merged,
    current_phase: buf.phase,
  } as Partial<TaskRecord>);

  buf.entries = [];
}

function appendTaskProgress(
  cfg: ChatroomConfig,
  taskId: string,
  entry: { phase: string; detail?: string },
): void {
  let buf = _progressBuffers.get(taskId);
  if (!buf) {
    buf = { entries: [], phase: entry.phase, flushTimer: null };
    _progressBuffers.set(taskId, buf);
  }
  buf.entries.push({ timestamp: nowISO(), ...entry });
  buf.phase = entry.phase;

  if (!buf.flushTimer) {
    buf.flushTimer = setTimeout(() => {
      _flushProgress(cfg, taskId);
      buf!.flushTimer = null;
    }, PROGRESS_FLUSH_INTERVAL_MS);
  }
}

function finalizeTaskProgress(cfg: ChatroomConfig, taskId: string): void {
  const buf = _progressBuffers.get(taskId);
  if (buf) {
    if (buf.flushTimer) clearTimeout(buf.flushTimer);
    _flushProgress(cfg, taskId);
    _progressBuffers.delete(taskId);
  }
}

// ============================================================================
// Task Parking — suspend long-running tasks without holding LLM sessions
// ============================================================================

function parkedTasksDir(cfg: ChatroomConfig): string {
  return path.join(chatroomRoot(cfg), "parked_tasks");
}

function writeParkedTask(cfg: ChatroomConfig, info: ParkedTaskInfo): void {
  const dir = parkedTasksDir(cfg);
  ensureDir(dir);
  writeJson(path.join(dir, `${info.task_id}.json`), info);
}

function readParkedTask(cfg: ChatroomConfig, taskId: string): ParkedTaskInfo | null {
  return readJson(path.join(parkedTasksDir(cfg), `${taskId}.json`));
}

function removeParkedTask(cfg: ChatroomConfig, taskId: string): void {
  const filePath = path.join(parkedTasksDir(cfg), `${taskId}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function listParkedTasks(cfg: ChatroomConfig): ParkedTaskInfo[] {
  const dir = parkedTasksDir(cfg);
  if (!fs.existsSync(dir)) return [];
  const results: ParkedTaskInfo[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const info = readJson(path.join(dir, file)) as ParkedTaskInfo | null;
    if (info) results.push(info);
  }
  return results;
}

function checkParkCondition(
  cfg: ChatroomConfig,
  info: ParkedTaskInfo,
  logger: Logger,
): { met: boolean; result: string } {
  try {
    switch (info.watch_type) {
      case "file": {
        const filePath = info.watch_config.file_path;
        if (!filePath) return { met: false, result: "No file_path configured" };
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          return {
            met: true,
            result: `File appeared: ${filePath} (${stat.size} bytes, modified ${stat.mtime.toISOString()})`,
          };
        }
        return { met: false, result: `Waiting for file: ${filePath}` };
      }
      case "shell": {
        const command = info.watch_config.command;
        if (!command) return { met: false, result: "No command configured" };
        const { execSync } = require("child_process");
        try {
          const output = execSync(command, {
            timeout: 30_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { met: true, result: `Command succeeded:\n${(output as string).slice(0, 2000)}` };
        } catch (err: any) {
          return {
            met: false,
            result: `Command still failing: exit ${err.status ?? "unknown"}`,
          };
        }
      }
      case "poll_url": {
        // Synchronous HTTP check via child_process curl
        const url = info.watch_config.url;
        if (!url) return { met: false, result: "No url configured" };
        const expectedStatus = info.watch_config.expected_status ?? 200;
        const { execSync } = require("child_process");
        try {
          const output = execSync(
            `curl -s -o /dev/null -w "%{http_code}" --max-time 10 ${JSON.stringify(url)}`,
            { encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] },
          );
          const statusCode = parseInt((output as string).trim(), 10);
          if (statusCode === expectedStatus) {
            return { met: true, result: `URL returned ${statusCode} (expected ${expectedStatus})` };
          }
          return {
            met: false,
            result: `URL returned ${statusCode}, waiting for ${expectedStatus}`,
          };
        } catch {
          return { met: false, result: `URL unreachable` };
        }
      }
      case "permission": {
        const permId = info.watch_config.permission_id;
        if (!permId) return { met: false, result: "No permission_id configured" };
        const permFile = path.join(permissionsDir(cfg), `${permId}.json`);
        const perm = readJson(permFile) as PermissionRecord | null;
        if (!perm) return { met: false, result: "Permission record not found" };
        if (perm.status === "approved" || perm.status === "allowlisted") {
          return {
            met: true,
            result: `Permission ${perm.status} by ${perm.decided_by ?? "admin"}`,
          };
        }
        if (perm.status === "rejected") {
          return {
            met: true,
            result: `Permission REJECTED by ${perm.decided_by ?? "admin"}: ${perm.decision_reason ?? "no reason given"}`,
          };
        }
        return { met: false, result: `Waiting for human approval (${perm.status})` };
      }
      default:
        return { met: false, result: `Unknown watch_type: ${info.watch_type}` };
    }
  } catch (err) {
    logger.error(`Park condition check failed for ${info.task_id}: ${err}`);
    return { met: false, result: `Check error: ${err}` };
  }
}

function monitorParkedTasks(cfg: ChatroomConfig, runtime: any, config: any, logger: Logger): void {
  const parked = listParkedTasks(cfg);
  if (parked.length === 0) return;

  const now = Date.now();

  for (const info of parked) {
    if (info.agent_id !== cfg.agentId) continue;

    const parkedAt = new Date(info.parked_at).getTime();
    const elapsed = now - parkedAt;

    if (elapsed > info.max_wait_ms) {
      logger.warn(`Parked task ${info.task_id} exceeded max wait (${info.max_wait_ms}ms)`);
      removeParkedTask(cfg, info.task_id);
      updateTaskRecord(cfg, info.task_id, {
        status: "FAILED",
        completed_at: nowISO(),
        error_type: "LLM_ERROR",
        error_detail: `Parked task timed out after ${Math.round(elapsed / 60000)} minutes`,
        current_phase: "park_timeout",
      } as Partial<TaskRecord>);
      sendMessageToNAS(
        cfg,
        info.channel_id,
        `[SYSTEM] Parked task ${info.task_id} timed out — waited ${Math.round(elapsed / 60000)}min for condition`,
        "SYSTEM",
        [],
      );
      continue;
    }

    const lastPoll = info.last_poll_at ? new Date(info.last_poll_at).getTime() : 0;
    if (now - lastPoll < info.poll_interval_ms) continue;

    info.last_poll_at = nowISO();
    info.poll_count++;
    writeParkedTask(cfg, info);

    const { met, result } = checkParkCondition(cfg, info, logger);
    appendTaskProgress(cfg, info.task_id, {
      phase: "parked_poll",
      detail: `[poll #${info.poll_count}] ${result.slice(0, 200)}`,
    });

    if (met) {
      logger.info(`Parked task ${info.task_id} condition met: ${result.slice(0, 100)}`);
      removeParkedTask(cfg, info.task_id);

      // Handle permission rejection: fail the task instead of resuming
      if (info.watch_type === "permission" && result.includes("REJECTED")) {
        updateTaskRecord(cfg, info.task_id, {
          status: "FAILED",
          completed_at: nowISO(),
          error_detail: `Permission denied: ${result}`,
          current_phase: "permission_rejected",
        } as Partial<TaskRecord>);

        sendMessageToNAS(
          cfg,
          info.channel_id,
          `[SYSTEM] Task ${info.task_id} — permission was denied by admin. The requested operation will not be executed.\n\nRejection: ${result}`,
          "SYSTEM",
          [],
          undefined,
          { task_id: info.task_id },
        );

        resetAgentStatus(cfg, info.agent_id, logger);
        logger.info(`Task ${info.task_id} failed due to permission rejection`);
        continue;
      }

      updateTaskRecord(cfg, info.task_id, {
        status: "PROCESSING",
        current_phase: "resuming_from_park",
      } as Partial<TaskRecord>);

      const isPermissionResume = info.watch_type === "permission";
      const resumeInstruction = isPermissionResume
        ? [
            `[TASK RESUMED — PERMISSION GRANTED]`,
            `task_id: ${info.task_id}`,
            `original_instruction: ${info.original_instruction}`,
            ``,
            `Your previously requested sensitive operation has been APPROVED by the admin.`,
            `${result}`,
            ``,
            `You may now proceed with the operation. Resume instructions:`,
            info.resume_prompt,
            ``,
            `Continue processing this task. Save outputs with chatroom_save_asset(task_id="${info.task_id}").`,
            `Your final text response will be delivered as the task result.`,
          ].join("\n")
        : [
            `[TASK RESUMED FROM PARK]`,
            `task_id: ${info.task_id}`,
            `original_instruction: ${info.original_instruction}`,
            ``,
            `The long-running operation has completed. Here is the result:`,
            result,
            ``,
            `Resume instructions from the agent:`,
            info.resume_prompt,
            ``,
            `Continue processing this task. Save outputs with chatroom_save_asset(task_id="${info.task_id}").`,
            `Your final text response will be delivered as the task result.`,
          ].join("\n");

      const syntheticMsg: InboxMessage = {
        message_id: `resume_${info.task_id}_${randomUUID()}`,
        timestamp: nowISO(),
        channel_id: info.channel_id,
        from: "system",
        content: { text: resumeInstruction, mentions: [info.agent_id] },
        type: "TASK_DISPATCH",
        metadata: {
          task_id: info.task_id,
          output_dir: taskAssetsDir(cfg, info.agent_id, info.task_id),
        },
        seq: 0,
      };

      autoDispatchForTask(cfg, syntheticMsg, info.task_id, runtime, config, logger);
    }
  }
}

// ============================================================================
// Sensitivity screening — programmatic pre-filter for the orchestrator
// ============================================================================

const SENSITIVE_PATTERNS: Array<{ re: RegExp; type: string; label: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*\//, type: "shell", label: "rm with absolute path" },
  { re: /\bsudo\b/, type: "shell", label: "sudo command" },
  { re: /\bchmod\b/, type: "system", label: "permission change" },
  { re: /\bchown\b/, type: "system", label: "ownership change" },
  { re: /\/etc\//, type: "read", label: "system config access" },
  { re: /\/usr\/(?:local|bin|sbin)\//, type: "write", label: "system directory write" },
  { re: /\.env\b/, type: "read", label: ".env file access" },
  {
    re: /(?:password|secret|credential|api_key|private_key)\s*[:=]/i,
    type: "read",
    label: "credential handling",
  },
  {
    re: /\bcurl\b.*(?:-d\b|-X\s*(?:POST|PUT|DELETE))/i,
    type: "network",
    label: "network mutation",
  },
  { re: /\bwget\b/, type: "network", label: "network download" },
  { re: /\bsystemctl\b|\bservice\s+/, type: "system", label: "system service operation" },
  { re: /\bkill\b|\bkillall\b/, type: "system", label: "process termination" },
  { re: /\biptables\b|\bufw\b/, type: "system", label: "firewall modification" },
  {
    re: /\bdocker\s+(?:rm|rmi|stop|kill|exec)\b/,
    type: "system",
    label: "docker destructive operation",
  },
];

function sensitivityPreFilter(
  text: string,
): { hit: boolean; type: string; label: string; detail: string } | null {
  for (const { re, type, label } of SENSITIVE_PATTERNS) {
    const match = text.match(re);
    if (match) {
      // Extract the surrounding context for the matched operation
      const idx = text.indexOf(match[0]);
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + match[0].length + 80);
      const detail = text.slice(start, end).trim();
      return { hit: true, type, label, detail };
    }
  }
  return null;
}

// ============================================================================
// Daemon message handlers — route by message type
// ============================================================================

function handleIncomingTask(
  cfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) {
    logger.warn(`TASK_DISPATCH without task_id from ${msg.from}, ignoring`);
    return;
  }

  const task = readTaskRecord(cfg, taskId);
  if (!task) {
    logger.warn(`Task ${taskId} not found on NAS, creating local record`);
    const dir = tasksDir(cfg);
    ensureDir(dir);
    const metaTimeout =
      typeof msg.metadata?.task_timeout_ms === "number" ? msg.metadata.task_timeout_ms : undefined;
    const synthetic: TaskRecord = {
      task_id: taskId,
      from: msg.from,
      to: cfg.agentId,
      channel_id: msg.channel_id,
      status: "DISPATCHED",
      instruction: msg.content.text,
      dispatched_at: msg.timestamp,
      acked_at: null,
      started_at: null,
      completed_at: null,
      result_summary: null,
      asset_paths: [],
      retries: 0,
      max_retries: 3,
      ack_timeout_ms: 30_000,
      task_timeout_ms: metaTimeout ?? 3_600_000,
    };
    writeJson(path.join(dir, `${taskId}.json`), synthetic);
  }

  const currentTask = readTaskRecord(cfg, taskId)!;
  sendSystemAck(cfg, currentTask, logger);

  updateTaskRecord(cfg, taskId, {
    status: "PROCESSING",
    started_at: nowISO(),
    current_phase: "processing",
    error_type: null,
    error_detail: null,
  } as Partial<TaskRecord>);
  setAgentWorking(cfg, cfg.agentId, taskId, logger);
  logger.info(`Processing task ${taskId} from ${msg.from}: "${msg.content.text.slice(0, 80)}..."`);

  autoDispatchForTask(cfg, msg, taskId, runtime, config, logger);
}

function handleTaskAck(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  if (task.status === "DISPATCHED" || task.status === "TIMEOUT" || task.status === "RETRYING") {
    updateTaskRecord(cfg, taskId, {
      status: "ACKED",
      acked_at: nowISO(),
      current_phase: "acked",
    } as Partial<TaskRecord>);
    logger.info(`Task ${taskId} ACK received from ${msg.from}`);
  }
}

function handleTaskResult(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  const resultStatus = (msg.metadata?.status as TaskStatus) || "DONE";
  const patch: Partial<TaskRecord> = {
    status: resultStatus,
    completed_at: nowISO(),
    result_summary: msg.content.text.slice(0, 500),
    asset_paths: msg.metadata?.asset_paths ?? [],
  };
  if (msg.metadata?.error_type) {
    patch.error_type = msg.metadata.error_type as TaskErrorType;
    patch.error_detail = msg.content.text.slice(0, 2000);
  }
  patch.current_phase = resultStatus === "DONE" ? "completed" : "failed";
  updateTaskRecord(cfg, taskId, patch);
  logger.info(
    `Task ${taskId} result received from ${msg.from} (${resultStatus}${patch.error_type ? ` [${patch.error_type}]` : ""})`,
  );
}

// ============================================================================
// ACK timeout monitoring
// ============================================================================

const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

function monitorPendingTasks(cfg: ChatroomConfig, logger: Logger): void {
  const pending = listTasksByStatus(cfg, "DISPATCHED", "TIMEOUT", "RETRYING");
  const now = Date.now();

  for (const task of pending) {
    if (task.from !== cfg.agentId) continue;

    // RETRYING tasks wait for the backoff period, then re-dispatch
    if (task.status === "RETRYING") {
      const completedAt = new Date(task.completed_at ?? task.dispatched_at).getTime();
      if (now - completedAt < RATE_LIMIT_RETRY_DELAY_MS) continue;

      if (task.retries >= task.max_retries) {
        updateTaskRecord(cfg, task.task_id, { status: "ABANDONED", completed_at: nowISO() });
        sendMessageToNAS(
          cfg,
          task.channel_id,
          `[SYSTEM] Task ${task.task_id} abandoned — rate limit retries exhausted (${task.max_retries} attempts)`,
          "SYSTEM",
          [],
        );
        logger.warn(`Task ${task.task_id} ABANDONED after ${task.max_retries} rate-limit retries`);
        continue;
      }

      updateTaskRecord(cfg, task.task_id, {
        status: "DISPATCHED",
        retries: task.retries + 1,
        dispatched_at: nowISO(),
        error_type: null,
        error_detail: null,
        completed_at: null,
        current_phase: "retrying",
      } as Partial<TaskRecord>);

      const root = chatroomRoot(cfg);
      const inboxDir = path.join(root, "inbox", task.to);
      ensureDir(inboxDir);
      const notif = {
        notification_id: randomUUID(),
        timestamp: nowISO(),
        channel_id: task.channel_id,
        message_seq: 0,
        from: cfg.agentId,
        preview: `[RATE-LIMIT RETRY ${task.retries + 1}/${task.max_retries}] ${task.instruction.slice(0, 80)}`,
        priority: "urgent",
        retry_for_task: task.task_id,
      };
      writeJson(path.join(inboxDir, `retry_${task.task_id}_${notif.notification_id}.json`), notif);
      logger.info(
        `Task ${task.task_id} rate-limit retry ${task.retries + 1}/${task.max_retries} → ${task.to}`,
      );
      continue;
    }

    const dispatchedAt = new Date(task.dispatched_at).getTime();
    const elapsed = now - dispatchedAt;

    if (elapsed > task.ack_timeout_ms) {
      if (task.retries >= task.max_retries) {
        updateTaskRecord(cfg, task.task_id, { status: "ABANDONED" });
        sendMessageToNAS(
          cfg,
          task.channel_id,
          `[SYSTEM] Task ${task.task_id} abandoned — ${task.to} did not respond after ${task.max_retries} retries`,
          "SYSTEM",
          [],
        );
        logger.warn(`Task ${task.task_id} ABANDONED (${task.to} unreachable)`);
      } else {
        updateTaskRecord(cfg, task.task_id, {
          status: "TIMEOUT",
          retries: task.retries + 1,
          dispatched_at: nowISO(),
        });
        const root = chatroomRoot(cfg);
        const inboxDir = path.join(root, "inbox", task.to);
        ensureDir(inboxDir);
        const notif = {
          notification_id: randomUUID(),
          timestamp: nowISO(),
          channel_id: task.channel_id,
          message_seq: 0,
          from: cfg.agentId,
          preview: `[RETRY ${task.retries + 1}/${task.max_retries}] ${task.instruction.slice(0, 80)}`,
          priority: "urgent",
          retry_for_task: task.task_id,
        };
        writeJson(
          path.join(inboxDir, `retry_${task.task_id}_${notif.notification_id}.json`),
          notif,
        );
        logger.warn(
          `Task ${task.task_id} ACK timeout — retry ${task.retries + 1}/${task.max_retries} sent to ${task.to}`,
        );
      }
    }
  }

  // Check PROCESSING tasks for timeouts
  const processing = listTasksByStatus(cfg, "ACKED", "PROCESSING");
  for (const task of processing) {
    if (task.from !== cfg.agentId) continue;
    const startedAt = new Date(task.started_at ?? task.acked_at ?? task.dispatched_at).getTime();
    if (now - startedAt > task.task_timeout_ms) {
      updateTaskRecord(cfg, task.task_id, {
        status: "FAILED",
        completed_at: nowISO(),
        error_type: "LLM_ERROR",
        error_detail: `Task timed out after ${Math.round(task.task_timeout_ms / 60000)} minutes`,
        current_phase: "timed_out",
      } as Partial<TaskRecord>);
      sendMessageToNAS(
        cfg,
        task.channel_id,
        `[SYSTEM] Task ${task.task_id} timed out — ${task.to} did not deliver results within ${Math.round(task.task_timeout_ms / 60000)}min`,
        "SYSTEM",
        [],
      );
      logger.warn(`Task ${task.task_id} TIMED OUT (${task.to})`);
    }
  }

  // React to error-typed FAILED tasks
  const failed = listTasksByStatus(cfg, "FAILED");
  for (const task of failed) {
    if (task.from !== cfg.agentId) continue;
    if (!task.error_type) continue;

    if (task.error_type === "RATE_LIMITED") {
      // Auto-retry: transition to RETRYING, the next monitor cycle will re-dispatch after delay
      logger.info(`Task ${task.task_id} failed with RATE_LIMITED — scheduling auto-retry`);
      updateTaskRecord(cfg, task.task_id, {
        status: "RETRYING",
        current_phase: "waiting_rate_limit",
      } as Partial<TaskRecord>);
      continue;
    }

    if (task.error_type === "CONTEXT_OVERFLOW") {
      // Notify orchestrator via system message so it can decide (simplify & re-dispatch or abort)
      const sysMsg =
        `[SYSTEM] Task ${task.task_id} failed: CONTEXT_OVERFLOW.\n` +
        `Target: ${task.to} | Instruction: "${task.instruction.slice(0, 100)}"\n` +
        `The instruction may be too complex for the agent's context window.\n` +
        `Options: simplify the instruction and re-dispatch, or cancel the task.`;
      sendMessageToNAS(cfg, "general", sysMsg, "SYSTEM", [cfg.agentId]);
      // Clear error_type so we don't notify repeatedly
      updateTaskRecord(cfg, task.task_id, { error_type: null } as Partial<TaskRecord>);
      logger.info(`Task ${task.task_id} CONTEXT_OVERFLOW — notified orchestrator in #general`);
      continue;
    }

    // LLM_ERROR / TOOL_ERROR: notify orchestrator once
    const sysMsg =
      `[SYSTEM] Task ${task.task_id} failed: ${task.error_type}.\n` +
      `Target: ${task.to} | Error: ${(task.error_detail ?? "unknown").slice(0, 200)}\n` +
      `Review the error and decide whether to re-dispatch or cancel.`;
    sendMessageToNAS(cfg, "general", sysMsg, "SYSTEM", [cfg.agentId]);
    updateTaskRecord(cfg, task.task_id, { error_type: null } as Partial<TaskRecord>);
    logger.info(`Task ${task.task_id} ${task.error_type} — notified orchestrator in #general`);
  }
}

// ============================================================================
// Orchestration context
// ============================================================================

function buildOrchestratorContext(cfg: ChatroomConfig, sourceChannel?: string): string {
  const agents = readAgentRegistry(cfg);
  const channels = listAgentChannels(cfg);

  const otherAgents = agents.filter((a) => a.agent_id !== cfg.agentId);
  if (otherAgents.length === 0 && channels.length === 0) return "";

  const myAssets = assetsDir(cfg, cfg.agentId);
  const sharedAssets = assetsDir(cfg, "shared");

  const lines: string[] = [
    `[Chatroom Orchestration Context]`,
    `You are "${cfg.agentId}", the Orchestrator of the First Agent Family.`,
    ``,
    `═══ CHANNEL RULES (MUST follow) ═══`,
    `  #general   → Human ↔ Orchestrator communication ONLY.`,
    `               When a human sends a message here, respond HERE and nowhere else.`,
    `               Do NOT post task results, progress updates, or agent replies to #general.`,
    `  #pipeline  → Pipeline status updates and progress summaries.`,
    `               Post stage progress (e.g. "Stage 1 complete, moving to Stage 2") here.`,
    `               Post final delivery summaries here when a full pipeline completes.`,
    `  #permission → Sensitive operation approval channel (system-managed).`,
    `               When agents encounter sensitive operations, the system posts approval`,
    `               requests here automatically. Human admins approve/reject via Web UI.`,
    `               Do NOT manually send messages to #permission.`,
    `  dm_{agent} → Private task channels between you and a specific agent.`,
    `               Task dispatch and result delivery happen here automatically via the protocol.`,
    `               Do NOT manually send messages to DM channels — the system handles it.`,
    ``,
    `  CRITICAL: Your response goes to the SAME channel as the incoming message.`,
    sourceChannel ? `  Current channel: #${sourceChannel}` : ``,
    ``,
    `═══ File System (NAS) ═══`,
    `  Your output dir: ${myAssets}`,
    `  Shared dir: ${sharedAssets}`,
    `  All agent assets: ${assetsDir(cfg)}`,
    `  When dispatching a task, the system auto-creates an output dir for the target.`,
    ``,
  ];

  if (otherAgents.length > 0) {
    lines.push(`═══ Available Agents ═══`);
    for (const a of otherAgents) {
      const dmChannel = `dm_${a.agent_id}`;
      const hasDM = channels.some((ch) => ch.channel_id === dmChannel);
      lines.push(
        `  - ${a.agent_id} (${a.display_name}) [${a.status}]${hasDM ? ` — DM: ${dmChannel}` : ""}`,
      );
    }
    lines.push(``);
  }

  lines.push(`═══ Task Dispatch Protocol ═══`);
  lines.push(`  Use chatroom_dispatch_task to assign work to agents.`);
  lines.push(`  The system handles: DM delivery → ACK → result collection.`);
  lines.push(`  Output files are placed in: ${assetsDir(cfg)}/{agent_id}/{task_id}/`);
  lines.push(``);
  lines.push(
    `  Example: chatroom_dispatch_task(target="art", instruction="draw a steel dinosaur")`,
  );
  lines.push(``);
  lines.push(`═══ File Sharing ═══`);
  lines.push(`  To send a file as a chat message: use chatroom_send_file.`);
  lines.push(`  To save a file without sending a message: use chatroom_save_asset.`);
  lines.push(``);

  const activeTasks = listTasksByStatus(
    cfg,
    "DISPATCHED",
    "ACKED",
    "PROCESSING",
    "RETRYING",
    "PARKED",
  );
  if (activeTasks.length > 0) {
    lines.push(`═══ Active Tasks ═══`);
    for (const t of activeTasks) {
      const phase = t.current_phase ? ` (${t.current_phase})` : "";
      const errInfo = t.error_type ? ` [ERROR: ${t.error_type}]` : "";
      const permNote =
        t.current_phase === "awaiting_permission" ? " ⏳ AWAITING ADMIN APPROVAL" : "";
      lines.push(
        `  - [${t.status}${phase}${errInfo}${permNote}] ${t.task_id.slice(0, 8)}... → ${t.to}: "${t.instruction.slice(0, 60)}"`,
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function buildWorkerContext(cfg: ChatroomConfig, sourceChannel?: string): string {
  const myAssets = assetsDir(cfg, cfg.agentId);
  const myDM = `dm_${cfg.agentId}`;

  const lines: string[] = [
    `[Agent Worker Context]`,
    `You are "${cfg.agentId}", a specialist worker agent in the First Agent Family.`,
    ``,
    `═══ YOUR ROLE ═══`,
    `  You are NOT the orchestrator. You are a task executor.`,
    `  You receive tasks via your DM channel (#${myDM}) from the orchestrator.`,
    `  You complete tasks and report results — that's it.`,
    ``,
    `═══ STRICT RULES ═══`,
    `  1. NEVER respond to human messages. You are not the orchestrator.`,
    `  2. NEVER send messages to #general. That channel is orchestrator-only.`,
    `  3. NEVER dispatch tasks to other agents. Only the orchestrator does that.`,
    `  4. ONLY communicate in your DM channel: #${myDM}.`,
    `  5. Focus entirely on completing the assigned task.`,
    `  6. BEFORE executing sensitive operations, use chatroom_request_permission.`,
    ``,
    `═══ SENSITIVE OPERATIONS (require permission) ═══`,
    `  You MUST call chatroom_request_permission BEFORE any of these:`,
    `  - Shell commands that modify files outside the workspace or project directory`,
    `  - Commands using sudo, rm -rf on system paths, chmod, chown`,
    `  - Reading or writing .env, credentials, API keys, secrets`,
    `  - System service operations (systemctl, docker rm/stop, kill)`,
    `  - Network requests that modify external state (POST/PUT/DELETE to APIs)`,
    `  If the operation is allowlisted, it will auto-approve instantly.`,
    `  Otherwise your session will pause until an admin decides.`,
    ``,
    `═══ File System (NAS) ═══`,
    `  Your output dir: ${myAssets}`,
    sourceChannel ? `  Current channel: #${sourceChannel}` : ``,
    ``,
  ];

  return lines.join("\n");
}

function buildChatroomContext(cfg: ChatroomConfig, sourceChannel?: string): string {
  if (cfg.role === "orchestrator") {
    return buildOrchestratorContext(cfg, sourceChannel);
  }
  return buildWorkerContext(cfg, sourceChannel);
}

// ============================================================================
// Auto-dispatch: push messages through the LLM pipeline
// ============================================================================

async function autoDispatchMessage(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  // Hard gate: workers must not respond outside their DM channel
  if (chatroomCfg.role !== "orchestrator") {
    const myDM = `dm_${chatroomCfg.agentId}`;
    if (channelId !== myDM) {
      logger.info(
        `[worker] Blocked LLM dispatch for #${channelId} — workers only respond in their DM`,
      );
      return;
    }
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
  });

  const senderLabel = msg.from.startsWith("human:")
    ? `[Human] ${msg.from.slice("human:".length)}`
    : msg.from;

  const chatroomContext = buildChatroomContext(chatroomCfg, channelId);
  const messageBody = `[Chatroom #${channelId}] ${senderLabel}: ${msg.content.text}`;
  const bodyForAgent = chatroomContext ? `${chatroomContext}\n${messageBody}` : messageBody;

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: msg.content.text,
    CommandBody: msg.content.text,
    From: `chatroom:${msg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: senderLabel,
    SenderId: msg.from,
    Provider: "chatroom",
    Surface: "chatroom",
    MessageSid: msg.message_id,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const prefixContext = createReplyPrefixContext({
    cfg: config,
    agentId: route.agentId,
  });

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;
      try {
        const inlineMentions = parseAtMentions(text);
        const result = sendMessageToNAS(chatroomCfg, channelId, text, "CHAT", inlineMentions);
        logger.info(`Auto-reply → #${channelId} (seq: ${result.seq})`);
      } catch (err) {
        logger.error(`Failed to send auto-reply to ${channelId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      logger.error(`Dispatch error (${info?.kind}): ${err}`);
    },
  };

  logger.info(`Dispatching chat from ${msg.from} in #${channelId} to LLM`);

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: { onModelSelected: prefixContext.onModelSelected },
  });
}

/**
 * Dispatch a TASK to the LLM. The deliver callback writes a RESULT_REPORT
 * (not a plain CHAT) so the orchestrator's task tracker picks it up.
 */
async function autoDispatchForTask(
  chatroomCfg: ChatroomConfig,
  msg: InboxMessage,
  taskId: string,
  runtime: any,
  config: any,
  logger: Logger,
): Promise<void> {
  const channelId = msg.channel_id;
  const isDM = channelId.startsWith("dm_");

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatroom",
    peer: { kind: isDM ? "direct" : "group", id: channelId },
  });

  const outputDir =
    msg.metadata?.output_dir ?? taskAssetsDir(chatroomCfg, chatroomCfg.agentId, taskId);
  ensureDir(outputDir as string);

  const taskContext = [
    `[CHATROOM TASK — STRICT PROTOCOL]`,
    `task_id: ${taskId}`,
    `assigned_by: ${msg.from}`,
    `output_dir: ${outputDir}`,
    ``,
    `INSTRUCTION:`,
    msg.content.text,
    ``,
    `RULES (MUST follow — violations break the pipeline):`,
    `1. SAVE all output files using chatroom_save_asset with task_id="${taskId}".`,
    `   This stores them in the correct NAS directory: ${outputDir}`,
    `   For binary files (images, audio): chatroom_save_asset(filename="output.png", content="<base64>", encoding="base64", task_id="${taskId}")`,
    `   For text files: chatroom_save_asset(filename="report.md", content="...", task_id="${taskId}")`,
    `2. To share files visually (so others can see images/download files), use chatroom_send_file:`,
    `   chatroom_send_file(channel_id="${msg.channel_id}", filename="output.png", content="<base64>", encoding="base64", task_id="${taskId}")`,
    `3. REPORT PROGRESS at significant milestones using chatroom_task_progress:`,
    `   chatroom_task_progress(task_id="${taskId}", phase="analyzing", detail="Reading the requirements")`,
    `   chatroom_task_progress(task_id="${taskId}", phase="generating", detail="Creating output")`,
    `   This keeps the orchestrator and dashboard informed of your progress.`,
    `4. Your final TEXT RESPONSE is your task result.`,
    `   The system AUTOMATICALLY delivers it as a RESULT_REPORT to the orchestrator.`,
    `5. For LONG-RUNNING OPERATIONS (builds, uploads, deployments >1min):`,
    `   Use chatroom_task_park to suspend your session while waiting.`,
    `   This saves tokens and prevents context overflow. A new session resumes when done.`,
    `   Example: chatroom_task_park(task_id="${taskId}", watch_type="file", file_path="/output/build.zip",`,
    `     resume_prompt="Build complete. Upload the zip and report results.", max_wait_minutes=30)`,
    `6. SENSITIVE OPERATIONS require permission. BEFORE executing any of these, call chatroom_request_permission:`,
    `   - Shell commands modifying system dirs (outside workspace), sudo, rm -rf on system paths`,
    `   - Reading/writing .env, credentials, API keys, secrets`,
    `   - System operations (systemctl, docker rm/stop, chmod, chown, kill)`,
    `   - Network mutations (POST/PUT/DELETE to external APIs)`,
    `   Example: chatroom_request_permission(task_id="${taskId}", operation_type="shell",`,
    `     operation_detail="rm -rf /usr/local/old-sdk", reason="Need to remove old SDK before installing new one",`,
    `     resume_prompt="Old SDK removed. Install the new SDK and continue.")`,
    `7. DO NOT send results via Lark, Feishu, or any other messaging channel.`,
    `   DO NOT call feishu tools, reply tools, or any messaging/notification tools.`,
    `   DO NOT attempt to notify anyone manually — the system handles ALL delivery.`,
    `8. Mention produced filenames in your text response so the orchestrator knows what was created.`,
  ].join("\n");

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: taskContext,
    BodyForAgent: taskContext,
    RawBody: msg.content.text,
    CommandBody: msg.content.text,
    From: `chatroom:${msg.from}`,
    To: `chatroom:${chatroomCfg.agentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDM ? "direct" : "group",
    SenderName: msg.from,
    SenderId: msg.from,
    Provider: "chatroom",
    Surface: "chatroom",
    MessageSid: msg.message_id,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  const prefixContext = createReplyPrefixContext({
    cfg: config,
    agentId: route.agentId,
  });

  let taskCompleted = false;

  appendTaskProgress(chatroomCfg, taskId, { phase: "llm_started", detail: "Dispatching to LLM" });

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;

      const kind = info?.kind ?? "final";

      if (kind === "tool") {
        appendTaskProgress(chatroomCfg, taskId, {
          phase: "tool_executed",
          detail: text.slice(0, 300),
        });
        return;
      }

      if (kind === "block") {
        appendTaskProgress(chatroomCfg, taskId, {
          phase: "generating",
          detail: text.slice(0, 200),
        });
        return;
      }

      // kind === "final" — complete the task
      if (taskCompleted) return;
      taskCompleted = true;

      try {
        if (payload.isError) {
          const errType = classifyError(text);
          logger.warn(`Task ${taskId} LLM error [${errType}]: ${text.slice(0, 150)}`);
          sendTaskResult(chatroomCfg, taskId, text, "FAILED", logger, [], errType);
          return;
        }

        const producedFiles = scanOutputDir(outputDir as string);
        sendTaskResult(chatroomCfg, taskId, text, "DONE", logger, producedFiles);
      } catch (err) {
        logger.error(`Failed to send task result for ${taskId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      if (taskCompleted) return;
      taskCompleted = true;
      const errText = `Task processing failed: ${err}`;
      const errType = classifyError(String(err));
      logger.error(`Task dispatch error for ${taskId} (${info?.kind}) [${errType}]: ${err}`);
      try {
        sendTaskResult(chatroomCfg, taskId, errText, "FAILED", logger, [], errType);
      } catch {
        /* ignore */
      }
    },
  };

  const task = readTaskRecord(chatroomCfg, taskId);
  const taskTimeoutMs = task?.task_timeout_ms;
  const agentTimeoutMs =
    taskTimeoutMs && taskTimeoutMs > 600_000 ? Math.min(taskTimeoutMs, 3_600_000) : undefined;

  logger.info(
    `Dispatching task ${taskId} to LLM` +
      (agentTimeoutMs ? ` (extended timeout: ${Math.round(agentTimeoutMs / 60000)}min)` : ""),
  );

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      toolsDeny: ["message", "feishu_*", "lark_*"],
      ...(agentTimeoutMs ? { agentTimeoutMs } : {}),
    },
  });
}

// ============================================================================
// Plugin definition
// ============================================================================

const agentChatroomPlugin = {
  id: "agent-chatroom",
  name: "Agent Chatroom",
  description: "Multi-agent collaboration chatroom over shared NAS with reliable task dispatch",

  register(api: FirstClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, any>;
    const nasRoot = pluginCfg.nasRoot as string;
    const agentId = pluginCfg.agentId as string;

    if (!nasRoot || !agentId) {
      api.logger.warn(
        "agent-chatroom: nasRoot and agentId are required in plugin config. Tools disabled.",
      );
      return;
    }

    const rawRole = (pluginCfg.role as string) ?? "worker";
    const role: "orchestrator" | "worker" = rawRole === "orchestrator" ? "orchestrator" : "worker";

    const cfg: ChatroomConfig = {
      nasRoot,
      agentId,
      role,
      localDir: (pluginCfg.localDir as string) ?? "./chatroom_local",
    };
    ensureDir(cfg.localDir);
    ensureDir(tasksDir(cfg));

    const runtime = api.runtime;
    const config = api.config;
    const logger: Logger = {
      info: (...args: any[]) => api.logger.info(`[chatroom] ${args.join(" ")}`),
      warn: (...args: any[]) => api.logger.warn(`[chatroom] ${args.join(" ")}`),
      error: (...args: any[]) => api.logger.error(`[chatroom] ${args.join(" ")}`),
    };

    logger.info(
      `Agent "${agentId}" initialized with role: ${role.toUpperCase()}` +
        (role === "worker"
          ? ` — will ONLY process messages from dm_${agentId}`
          : ` — full orchestration enabled`),
    );

    // ── Orchestrator-only tools ─────────────────────────────────────────────
    // dispatch_task, cancel_task, task_status are only useful for the orchestrator.
    // Workers receive tasks; they don't create or manage them.

    if (role === "orchestrator") {
      api.registerTool(
        {
          name: "chatroom_dispatch_task",
          label: "Chatroom: Dispatch Task",
          description:
            "Dispatch a task to another agent with guaranteed delivery via the handshake protocol.\n" +
            "The target agent will:\n" +
            "  1. Instantly ACK (system-level, no delay)\n" +
            "  2. Process the instruction via its LLM\n" +
            "  3. Return a RESULT_REPORT\n" +
            "If no ACK is received within timeout, the system retries automatically.\n\n" +
            "Use this instead of chatroom_send_message when you need an agent to do work.",
          parameters: Type.Object({
            target: Type.String({
              description: "Target agent ID (e.g. 'art', 'audio', 'gamedev', 'uiux')",
            }),
            instruction: Type.String({
              description: "What you want the agent to do — be specific and actionable",
            }),
            timeout_minutes: Type.Optional(
              Type.Number({
                description:
                  "Task timeout in minutes. Default: 60. " +
                  "Set higher for long-running tasks (e.g. 120 for publishing/deployment).",
              }),
            ),
            long_running: Type.Optional(
              Type.Boolean({
                description:
                  "Mark as long-running task (builds, deploys, uploads). " +
                  "The agent will be advised to use chatroom_task_park for waiting periods.",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as {
                target: string;
                instruction: string;
                timeout_minutes?: number;
                long_running?: boolean;
              };
              const timeoutMs = (p.timeout_minutes ?? 60) * 60_000;
              let instruction = p.instruction;
              if (p.long_running) {
                instruction +=
                  "\n\n[LONG-RUNNING TASK] This task may involve operations that take minutes " +
                  "(builds, uploads, deployments). Use chatroom_task_park to suspend your session " +
                  "while waiting for long operations instead of polling or sleeping. This prevents " +
                  "context overflow and saves tokens.";
              }
              const task = dispatchTask(cfg, p.target, instruction, logger, {
                taskTimeoutMs: timeoutMs,
              });
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Task dispatched to ${p.target}.\n` +
                      `  task_id: ${task.task_id}\n` +
                      `  channel: #${task.channel_id}\n` +
                      `  timeout: ${p.timeout_minutes ?? 60} minutes\n` +
                      `  long_running: ${p.long_running ?? false}\n` +
                      `  status: DISPATCHED (awaiting ACK)\n` +
                      `The system will auto-retry if ${p.target} doesn't respond.`,
                  },
                ],
                details: task,
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error dispatching task: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_dispatch_task"] },
      );

      // ── Tool: check task status ─────────────────────────────────────────────

      api.registerTool(
        {
          name: "chatroom_task_status",
          label: "Chatroom: Task Status",
          description:
            "Check the status of dispatched tasks. Shows active, completed, and failed tasks.",
          parameters: Type.Object({
            task_id: Type.Optional(
              Type.String({
                description: "Specific task ID to check, or omit for all active tasks",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as { task_id?: string };
              if (p.task_id) {
                const task = readTaskRecord(cfg, p.task_id);
                if (!task)
                  return {
                    content: [{ type: "text" as const, text: `Task ${p.task_id} not found` }],
                    details: undefined,
                  };
                return {
                  content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
                  details: task,
                };
              }
              const active = listTasksByStatus(cfg, "DISPATCHED", "ACKED", "PROCESSING", "TIMEOUT");
              if (active.length === 0)
                return {
                  content: [{ type: "text" as const, text: "No active tasks." }],
                  details: undefined,
                };
              const summary = active.map((t) => ({
                task_id: t.task_id,
                to: t.to,
                status: t.status,
                instruction: t.instruction.slice(0, 80),
                dispatched_at: t.dispatched_at,
                retries: t.retries,
              }));
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `${active.length} active task(s):\n${JSON.stringify(summary, null, 2)}`,
                  },
                ],
                details: summary,
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_task_status"] },
      );

      // ── Tool: cancel / terminate a task ──────────────────────────────────

      api.registerTool(
        {
          name: "chatroom_cancel_task",
          label: "Chatroom: Cancel Task",
          description:
            "Cancel an active task. Use this when:\n" +
            "  - A task is stuck (agent cannot complete it)\n" +
            "  - You want to reassign the work to a different agent\n" +
            "  - The task is no longer needed\n" +
            "Sets the task status to CANCELLED, notifies the target agent, and resets their status to idle.",
          parameters: Type.Object({
            task_id: Type.String({ description: "The task ID to cancel" }),
            reason: Type.Optional(
              Type.String({ description: "Why the task is being cancelled (shown to the agent)" }),
            ),
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as { task_id: string; reason?: string };
              const reason = p.reason ?? "Cancelled by orchestrator";
              const result = cancelTask(cfg, p.task_id, reason, logger);
              if (!result) {
                return {
                  content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                  details: undefined,
                };
              }
              if (result.status !== "CANCELLED") {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Task ${p.task_id} is already in terminal state: ${result.status}. No action taken.`,
                    },
                  ],
                  details: result,
                };
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Task ${p.task_id} cancelled.\n` +
                      `  Target: ${result.to}\n` +
                      `  Previous status: ${result.status}\n` +
                      `  Reason: ${reason}\n` +
                      `  Agent ${result.to} status reset to idle.`,
                  },
                ],
                details: result,
              };
            } catch (err) {
              return {
                content: [{ type: "text" as const, text: `Error: ${err}` }],
                details: undefined,
              };
            }
          },
        },
        { names: ["chatroom_cancel_task"] },
      );
    } // end orchestrator-only tools

    // ── Shared tools (available to ALL agents) ────────────────────────────

    // ── Tool: save asset to NAS ───────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_save_asset",
        label: "Chatroom: Save Asset",
        description:
          "Save a file to the NAS shared storage. Use this when completing a task to ensure " +
          "your output is stored in the correct location.\n" +
          "The file will be saved to your agent's asset directory on the NAS.\n" +
          "Provide the content as text (for text files) or base64 (for binary files).",
        parameters: Type.Object({
          filename: Type.String({
            description: "File name (e.g. 'steel_dinosaur.png', 'report.md')",
          }),
          content: Type.String({
            description:
              "File content — plain text for text files, base64-encoded string for binary files",
          }),
          encoding: Type.Optional(
            Type.String({
              description: "'text' (default) or 'base64' for binary files",
            }),
          ),
          task_id: Type.Optional(
            Type.String({
              description:
                "Task ID — saves to the task-specific output directory. If omitted, saves to your general agent directory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              filename: string;
              content: string;
              encoding?: string;
              task_id?: string;
            };
            const dir = p.task_id
              ? taskAssetsDir(cfg, cfg.agentId, p.task_id)
              : assetsDir(cfg, cfg.agentId);
            ensureDir(dir);
            const filePath = toForwardSlash(path.join(dir, p.filename));

            if (p.encoding === "base64") {
              fs.writeFileSync(filePath, Buffer.from(p.content, "base64"));
            } else {
              fs.writeFileSync(filePath, p.content, "utf-8");
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: `File saved: ${filePath} (${fs.statSync(filePath).size} bytes)`,
                },
              ],
              details: { path: filePath, size: fs.statSync(filePath).size },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error saving file: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_save_asset"] },
    );

    // ── Tool: send message (general chat, non-task) ─────────────────────────

    api.registerTool(
      {
        name: "chatroom_send_message",
        label: "Chatroom: Send Message",
        description:
          "Send a general chat message to a channel. For task assignments, use chatroom_dispatch_task instead.\n" +
          "Use this for: status updates, questions, broadcasting information, chatting.\n" +
          "Optionally attach files already saved on NAS via asset_paths.",
        parameters: Type.Object({
          channel_id: Type.String({
            description: "Target channel ID (e.g. 'general', 'pipeline', 'dm_art')",
          }),
          text: Type.String({ description: "Message content" }),
          mentions: Type.Optional(
            Type.Array(Type.String(), { description: "Agent IDs to @mention" }),
          ),
          asset_paths: Type.Optional(
            Type.Array(Type.String(), {
              description: "NAS file paths to attach (e.g. from chatroom_save_asset output)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              channel_id: string;
              text: string;
              mentions?: string[];
              asset_paths?: string[];
            };

            // Workers cannot post to #general — orchestrator-only channel
            if (cfg.role !== "orchestrator" && p.channel_id === "general") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Blocked: #general is reserved for the orchestrator. Use your DM channel (dm_${cfg.agentId}) instead.`,
                  },
                ],
                details: undefined,
              };
            }

            const metadata: Record<string, any> = {};
            if (p.asset_paths?.length) metadata.asset_paths = p.asset_paths;
            const result = sendMessageToNAS(
              cfg,
              p.channel_id,
              p.text,
              "CHAT",
              p.mentions ?? [],
              undefined,
              metadata,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Message sent to #${p.channel_id} (seq: ${result.seq})` +
                    (p.asset_paths?.length ? ` with ${p.asset_paths.length} attachment(s)` : ""),
                },
              ],
              details: result,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_send_message"] },
    );

    // ── Tool: upload file and send as message ────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_send_file",
        label: "Chatroom: Upload & Send File",
        description:
          "Upload a file to NAS and send it as a chat message in one step.\n" +
          "The file is saved to your agent's asset directory and a message with the file " +
          "attached is posted to the specified channel.\n" +
          "Images will be displayed inline in the chatroom UI. Other files appear as download links.\n" +
          "For binary files (images, audio, etc.), set encoding to 'base64'.",
        parameters: Type.Object({
          channel_id: Type.String({
            description: "Target channel ID (e.g. 'general', 'pipeline')",
          }),
          filename: Type.String({
            description: "File name with extension (e.g. 'concept_art.png', 'report.md')",
          }),
          content: Type.String({
            description:
              "File content — plain text for text files, base64-encoded string for binary files",
          }),
          encoding: Type.Optional(
            Type.String({
              description: "'text' (default) or 'base64' for binary files like images",
            }),
          ),
          text: Type.Optional(
            Type.String({
              description: "Optional message text to accompany the file. Defaults to the filename.",
            }),
          ),
          task_id: Type.Optional(
            Type.String({
              description: "If part of a task, saves to the task-specific directory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              channel_id: string;
              filename: string;
              content: string;
              encoding?: string;
              text?: string;
              task_id?: string;
            };

            // Workers cannot post to #general
            if (cfg.role !== "orchestrator" && p.channel_id === "general") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Blocked: #general is reserved for the orchestrator. Use your DM channel (dm_${cfg.agentId}) instead.`,
                  },
                ],
                details: undefined,
              };
            }

            const dir = p.task_id
              ? taskAssetsDir(cfg, cfg.agentId, p.task_id)
              : assetsDir(cfg, cfg.agentId);
            ensureDir(dir);
            const filePath = toForwardSlash(path.join(dir, p.filename));

            if (p.encoding === "base64") {
              fs.writeFileSync(filePath, Buffer.from(p.content, "base64"));
            } else {
              fs.writeFileSync(filePath, p.content, "utf-8");
            }

            const fileSize = fs.statSync(filePath).size;
            const msgText = p.text ?? `📎 ${p.filename}`;
            const result = sendMessageToNAS(cfg, p.channel_id, msgText, "CHAT", [], undefined, {
              asset_paths: [filePath],
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `File uploaded and message sent to #${p.channel_id} (seq: ${result.seq})\n` +
                    `  Path: ${filePath} (${fileSize} bytes)`,
                },
              ],
              details: { path: filePath, size: fileSize, seq: result.seq },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_send_file"] },
    );

    // ── Tool: list channels ─────────────────────────────────────────────────

    api.registerTool(
      {
        name: "chatroom_list_channels",
        label: "Chatroom: List Channels",
        description: "List all chatroom channels this agent belongs to.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const channels = listAgentChannels(cfg);
            const text = JSON.stringify(
              channels.map((ch: any) => ({
                id: ch.channel_id,
                name: ch.display_name,
                type: ch.type,
                members: ch.members,
              })),
              null,
              2,
            );
            return { content: [{ type: "text" as const, text }], details: undefined };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_list_channels"] },
    );

    // ── Tool: check inbox (manual, usually not needed) ──────────────────────

    api.registerTool(
      {
        name: "chatroom_check_inbox",
        label: "Chatroom: Check Inbox",
        description:
          "Manually check inbox. Usually not needed — the daemon auto-dispatches messages.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
          try {
            const msgs = pollInbox(cfg);
            updateHeartbeat(cfg);
            if (msgs.length === 0)
              return {
                content: [{ type: "text" as const, text: "No new messages." }],
                details: undefined,
              };
            const all = msgs.map((m) => ({
              channel: m.channel_id,
              from: m.from,
              type: m.type,
              text: m.content?.text ?? "",
              message_id: m.message_id,
            }));
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${all.length} message(s):\n${JSON.stringify(all, null, 2)}`,
                },
              ],
              details: all,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_check_inbox"] },
    );

    // ── Tool: report task progress (available to all agents) ────────────────

    api.registerTool(
      {
        name: "chatroom_task_progress",
        label: "Chatroom: Report Task Progress",
        description:
          "Report progress on an active task. Use this to keep the orchestrator informed of " +
          "what you are currently doing.\n\n" +
          "Examples:\n" +
          '  chatroom_task_progress(task_id="abc...", phase="generating_image", detail="Creating base composition")\n' +
          '  chatroom_task_progress(task_id="abc...", phase="uploading", detail="Pushing to NAS")\n\n' +
          "Call this at significant milestones so the orchestrator and dashboard can track your progress.",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID you are working on" }),
          phase: Type.String({
            description:
              "Short phase label (e.g. 'analyzing', 'generating', 'uploading', 'finalizing')",
          }),
          detail: Type.Optional(
            Type.String({ description: "Optional details about what is happening" }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as { task_id: string; phase: string; detail?: string };
            appendTaskProgress(cfg, p.task_id, {
              phase: p.phase,
              detail: p.detail,
            });
            updateTaskRecord(cfg, p.task_id, { current_phase: p.phase } as Partial<TaskRecord>);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Progress recorded: [${p.phase}]${p.detail ? ` ${p.detail}` : ""}`,
                },
              ],
              details: { task_id: p.task_id, phase: p.phase },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_task_progress"] },
    );

    // ── Tool: park a task for long-running operations ───────────────────────

    api.registerTool(
      {
        name: "chatroom_task_park",
        label: "Chatroom: Park Task (Long-Running)",
        description:
          "Park a task to wait for a long-running operation WITHOUT holding the LLM session.\n" +
          "Use this when you need to wait for something that takes minutes or longer:\n" +
          "  - A build/compile process to finish\n" +
          "  - A file to appear (e.g. build output, download)\n" +
          "  - An HTTP endpoint to become available\n\n" +
          "HOW IT WORKS:\n" +
          "  1. You call this tool with what to watch for and what to do when it's ready\n" +
          "  2. Your LLM session ENDS immediately (saving tokens and context)\n" +
          "  3. A lightweight system monitor checks the condition periodically\n" +
          "  4. When the condition is met, a NEW LLM session starts with your resume_prompt\n\n" +
          "IMPORTANT: After calling this tool, your response will be your FINAL output.\n" +
          "Put all continuation logic in resume_prompt.\n\n" +
          "Watch types:\n" +
          '  - "shell": Run a command; condition met when it exits 0\n' +
          '  - "file": Wait for a file to appear at a path\n' +
          '  - "poll_url": Poll a URL; condition met when it returns expected status code\n\n' +
          "Example:\n" +
          '  chatroom_task_park(task_id="abc", watch_type="shell",\n' +
          '    command="test -f /output/build.zip && echo done",\n' +
          '    resume_prompt="Build finished. Upload build.zip to NAS and report.",\n' +
          "    poll_interval_ms=30000, max_wait_minutes=30)",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID being parked" }),
          watch_type: Type.String({
            description: 'What to watch: "shell", "file", or "poll_url"',
          }),
          command: Type.Optional(
            Type.String({
              description: 'For watch_type="shell": the command to run (success = exit 0)',
            }),
          ),
          file_path: Type.Optional(
            Type.String({
              description: 'For watch_type="file": absolute path to watch for',
            }),
          ),
          url: Type.Optional(
            Type.String({
              description: 'For watch_type="poll_url": the URL to poll',
            }),
          ),
          expected_status: Type.Optional(
            Type.Number({
              description: 'For watch_type="poll_url": expected HTTP status (default 200)',
            }),
          ),
          resume_prompt: Type.String({
            description:
              "Instructions for the NEW LLM session when the condition is met. " +
              "Include everything the agent needs to continue (what to do next, file paths, etc.)",
          }),
          poll_interval_ms: Type.Optional(
            Type.Number({
              description: "How often to check the condition in ms (default 30000 = 30s)",
            }),
          ),
          max_wait_minutes: Type.Optional(
            Type.Number({
              description: "Maximum time to wait in minutes (default 30, max 120)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              watch_type: string;
              command?: string;
              file_path?: string;
              url?: string;
              expected_status?: number;
              resume_prompt: string;
              poll_interval_ms?: number;
              max_wait_minutes?: number;
            };

            const task = readTaskRecord(cfg, p.task_id);
            if (!task) {
              return {
                content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                details: undefined,
              };
            }

            const watchType = p.watch_type as ParkWatchType;
            if (!["shell", "file", "poll_url"].includes(watchType)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Invalid watch_type "${p.watch_type}". Use "shell", "file", or "poll_url".`,
                  },
                ],
                details: undefined,
              };
            }

            const maxWaitMinutes = Math.min(p.max_wait_minutes ?? 30, 120);
            const pollInterval = Math.max(p.poll_interval_ms ?? 30_000, 5_000);

            const parkedInfo: ParkedTaskInfo = {
              task_id: p.task_id,
              agent_id: cfg.agentId,
              channel_id: task.channel_id,
              original_instruction: task.instruction,
              resume_prompt: p.resume_prompt,
              watch_type: watchType,
              watch_config: {
                command: p.command,
                file_path: p.file_path,
                url: p.url,
                expected_status: p.expected_status,
              },
              poll_interval_ms: pollInterval,
              max_wait_ms: maxWaitMinutes * 60_000,
              parked_at: nowISO(),
              last_poll_at: null,
              poll_count: 0,
            };

            writeParkedTask(cfg, parkedInfo);

            updateTaskRecord(cfg, p.task_id, {
              status: "PARKED",
              current_phase: `parked_${watchType}`,
            } as Partial<TaskRecord>);
            appendTaskProgress(cfg, p.task_id, {
              phase: "parked",
              detail: `Parked: watching ${watchType} (poll every ${pollInterval / 1000}s, max ${maxWaitMinutes}min)`,
            });

            logger.info(
              `Task ${p.task_id} PARKED: ${watchType}, poll ${pollInterval}ms, max ${maxWaitMinutes}min`,
            );

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Task ${p.task_id} is now PARKED.\n` +
                    `Watch: ${watchType} (poll every ${pollInterval / 1000}s, max wait ${maxWaitMinutes}min)\n` +
                    `Your LLM session will end now. When the condition is met, a new session ` +
                    `will start with your resume_prompt.\n\n` +
                    `You can now provide a brief status message as your final response.`,
                },
              ],
              details: parkedInfo,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error parking task: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_task_park"] },
    );

    // ── Tool: request permission for sensitive operations ──────────────────

    api.registerTool(
      {
        name: "chatroom_request_permission",
        label: "Chatroom: Request Permission",
        description:
          "Request human admin approval before executing a sensitive operation.\n" +
          "Use this BEFORE performing any of these operations:\n" +
          "  - Shell commands that modify system directories (outside workspace)\n" +
          "  - Reading or writing sensitive files (.env, credentials, keys)\n" +
          "  - System-level operations (chmod, chown, systemctl, docker rm)\n" +
          "  - Network operations that mutate external state (POST/PUT/DELETE)\n\n" +
          "HOW IT WORKS:\n" +
          "  1. You call this tool describing the operation you want to perform\n" +
          "  2. If the operation is already allowlisted, it auto-approves instantly\n" +
          "  3. Otherwise, your LLM session ENDS and the request goes to the admin\n" +
          "  4. When approved, a NEW session starts with your resume_prompt\n" +
          "  5. If rejected, the task is marked as failed\n\n" +
          "IMPORTANT: After calling this tool (if not auto-approved), your next response is FINAL.",
        parameters: Type.Object({
          task_id: Type.String({ description: "The task ID you are working on" }),
          operation_type: Type.String({
            description: 'Type of operation: "shell", "write", "read", "network", or "system"',
          }),
          operation_detail: Type.String({
            description:
              "The actual command or file path (e.g. 'rm -rf /usr/local/old-sdk' or '/etc/nginx/nginx.conf')",
          }),
          reason: Type.String({
            description: "Brief explanation of why this operation is needed",
          }),
          resume_prompt: Type.String({
            description: "Instructions for the NEW LLM session if the operation is approved",
          }),
        }),
        async execute(_toolCallId, params) {
          try {
            const p = params as {
              task_id: string;
              operation_type: string;
              operation_detail: string;
              reason: string;
              resume_prompt: string;
            };

            const task = readTaskRecord(cfg, p.task_id);
            if (!task) {
              return {
                content: [{ type: "text" as const, text: `Task ${p.task_id} not found.` }],
                details: undefined,
              };
            }

            // Check allowlist first
            if (matchesAllowlist(cfg, p.operation_type, p.operation_detail)) {
              logger.info(
                `Permission auto-approved (allowlisted) for task ${p.task_id}: ${p.operation_type} ${p.operation_detail.slice(0, 60)}`,
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Operation auto-approved (allowlisted). You may proceed.\n` +
                      `  type: ${p.operation_type}\n` +
                      `  detail: ${p.operation_detail}`,
                  },
                ],
                details: { auto_approved: true },
              };
            }

            // Create permission request
            const permRecord = createPermissionRequest(
              cfg,
              p.task_id,
              cfg.agentId,
              task.channel_id,
              p.operation_type,
              p.operation_detail,
              p.reason,
              task.instruction,
              p.resume_prompt,
              logger,
            );

            // Park the task with watch_type="permission"
            const parkedInfo: ParkedTaskInfo = {
              task_id: p.task_id,
              agent_id: cfg.agentId,
              channel_id: task.channel_id,
              original_instruction: task.instruction,
              resume_prompt: p.resume_prompt,
              watch_type: "permission",
              watch_config: {
                permission_id: permRecord.permission_id,
              },
              poll_interval_ms: 5_000,
              max_wait_ms: 24 * 60 * 60_000,
              parked_at: nowISO(),
              last_poll_at: null,
              poll_count: 0,
            };
            writeParkedTask(cfg, parkedInfo);

            updateTaskRecord(cfg, p.task_id, {
              status: "PARKED",
              current_phase: "awaiting_permission",
            } as Partial<TaskRecord>);

            appendTaskProgress(cfg, p.task_id, {
              phase: "awaiting_permission",
              detail: `Permission requested: ${p.operation_type} — ${p.operation_detail.slice(0, 100)}`,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Permission request submitted (ID: ${permRecord.permission_id.slice(0, 8)}...).\n` +
                    `Task is now PARKED awaiting admin approval.\n` +
                    `  Operation: ${p.operation_type} — ${p.operation_detail}\n` +
                    `  Reason: ${p.reason}\n\n` +
                    `Your LLM session will end now. If approved, a new session starts with your resume_prompt.\n` +
                    `Provide a brief status message as your final response.`,
                },
              ],
              details: { permission_id: permRecord.permission_id, parked: true },
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Error requesting permission: ${err}` }],
              details: undefined,
            };
          }
        },
      },
      { names: ["chatroom_request_permission"] },
    );

    // ── Background service ──────────────────────────────────────────────────

    const pollIntervalMs = (pluginCfg.pollIntervalMs as number) ?? 3000;
    const taskMonitorIntervalMs = (pluginCfg.taskMonitorIntervalMs as number) ?? 10_000;
    const parkMonitorIntervalMs = (pluginCfg.parkMonitorIntervalMs as number) ?? 15_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let taskMonitorTimer: ReturnType<typeof setInterval> | null = null;
    let parkMonitorTimer: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "chatroom-daemon",
      start: async () => {
        logger.info(
          `Chatroom daemon started for agent=${agentId}, role=${cfg.role.toUpperCase()} (task protocol enabled)`,
        );
        updateHeartbeat(cfg);

        // Post-update version report
        try {
          const marker = readAndClearSelfUpdateMarker();
          if (marker) {
            const newVersion = readProjectVersion();
            const commit = readProjectCommit();
            ensureUpgradeChannel(cfg);
            const prev = marker.previous_version;
            sendMessageToNAS(
              cfg,
              UPGRADE_CHANNEL_ID,
              `[${cfg.agentId}] Update complete, restarted. Version: v${prev} -> v${newVersion} (${commit})`,
              "STATUS_UPDATE",
            );
            logger.info(
              `[self-update] Post-restart report: v${prev} -> v${newVersion} (${commit})`,
            );
          }
        } catch (err) {
          logger.warn(`[self-update] Failed to send post-restart report: ${err}`);
        }

        heartbeatTimer = setInterval(() => {
          try {
            updateHeartbeat(cfg);
          } catch {
            /* ignore */
          }
        }, 30_000);

        // Main inbox poll — routes messages by type
        const myDM = `dm_${cfg.agentId}`;
        pollTimer = setInterval(async () => {
          try {
            const messages = pollInbox(cfg);
            for (const msg of messages) {
              try {
                // ── System command gate: self-update bypasses DM restriction ──
                if (isSelfUpdateCommand(msg)) {
                  if (isSelfUpdateAuthorized(msg)) {
                    await handleSelfUpdate(cfg, msg, logger);
                  } else {
                    logger.warn(
                      `[self-update] Unauthorized update request from ${msg.from}, ignoring`,
                    );
                  }
                  continue;
                }

                // ── #upgrade is a system-only channel — never forward to LLM ──
                if (msg.channel_id === UPGRADE_CHANNEL_ID) {
                  continue;
                }

                // ── Hard gate: workers ONLY process their own DM channel ──
                if (cfg.role !== "orchestrator") {
                  if (msg.channel_id !== myDM) {
                    logger.info(
                      `[worker] Dropping message from #${msg.channel_id} (only DM allowed)`,
                    );
                    continue;
                  }
                }

                switch (msg.type) {
                  case "TASK_DISPATCH":
                    handleIncomingTask(cfg, msg, runtime, config, logger);
                    break;
                  case "TASK_ACK":
                    handleTaskAck(cfg, msg, logger);
                    break;
                  case "RESULT_REPORT":
                    handleTaskResult(cfg, msg, logger);
                    // Orchestrator: screen for sensitive operations before forwarding
                    if (cfg.role === "orchestrator") {
                      const screening = sensitivityPreFilter(msg.content.text);
                      if (screening) {
                        const taskId = msg.metadata?.task_id as string | undefined;
                        if (taskId && !matchesAllowlist(cfg, screening.type, screening.detail)) {
                          logger.warn(
                            `Sensitivity screening triggered for task ${taskId}: ${screening.label}`,
                          );
                          createPermissionRequest(
                            cfg,
                            taskId,
                            msg.from,
                            msg.channel_id,
                            screening.type,
                            screening.detail,
                            `Orchestrator screening: ${screening.label} detected in result from ${msg.from}`,
                            "",
                            `Review the agent's result report and decide on next steps.`,
                            logger,
                          );
                          break;
                        }
                      }
                    }
                    await autoDispatchMessage(cfg, msg, runtime, config, logger);
                    break;
                  default:
                    await autoDispatchMessage(cfg, msg, runtime, config, logger);
                    break;
                }
              } catch (err) {
                logger.error(`Message handling failed for ${msg.message_id}: ${err}`);
              }
            }
          } catch {
            /* ignore */
          }
        }, pollIntervalMs);

        // Task timeout / retry monitor (orchestrator only — workers don't dispatch tasks)
        if (cfg.role === "orchestrator") {
          taskMonitorTimer = setInterval(() => {
            try {
              monitorPendingTasks(cfg, logger);
            } catch {
              /* ignore */
            }
          }, taskMonitorIntervalMs);
        }

        // Park monitor — checks parked task conditions (all agents)
        parkMonitorTimer = setInterval(() => {
          try {
            monitorParkedTasks(cfg, runtime, config, logger);
          } catch {
            /* ignore */
          }
        }, parkMonitorIntervalMs);
      },
      stop: async () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (taskMonitorTimer) clearInterval(taskMonitorTimer);
        if (parkMonitorTimer) clearInterval(parkMonitorTimer);
        logger.info("Chatroom daemon stopped");
      },
    });
  },
};

export default agentChatroomPlugin;
