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
  | "CANCELLED";

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
): void {
  const task = readTaskRecord(cfg, taskId);
  if (!task) {
    logger.warn(`Cannot send result — task ${taskId} not found`);
    return;
  }
  sendMessageToNAS(cfg, task.channel_id, resultText, "RESULT_REPORT", [task.from], undefined, {
    task_id: taskId,
    status,
    asset_paths: assetPaths,
  });
  updateTaskRecord(cfg, taskId, {
    status,
    completed_at: nowISO(),
    result_summary: resultText.slice(0, 500),
    asset_paths: assetPaths,
  });
  resetAgentStatus(cfg, task.to, logger);
  logger.info(`Result sent for task ${taskId} (${status}) → ${task.from}`);
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
      task_timeout_ms: 600_000,
    };
    writeJson(path.join(dir, `${taskId}.json`), synthetic);
  }

  const currentTask = readTaskRecord(cfg, taskId)!;
  sendSystemAck(cfg, currentTask, logger);

  updateTaskRecord(cfg, taskId, { status: "PROCESSING", started_at: nowISO() });
  setAgentWorking(cfg, cfg.agentId, taskId, logger);
  logger.info(`Processing task ${taskId} from ${msg.from}: "${msg.content.text.slice(0, 80)}..."`);

  autoDispatchForTask(cfg, msg, taskId, runtime, config, logger);
}

function handleTaskAck(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  if (task.status === "DISPATCHED" || task.status === "TIMEOUT") {
    updateTaskRecord(cfg, taskId, { status: "ACKED", acked_at: nowISO() });
    logger.info(`Task ${taskId} ACK received from ${msg.from}`);
  }
}

function handleTaskResult(cfg: ChatroomConfig, msg: InboxMessage, logger: Logger): void {
  const taskId = msg.metadata?.task_id;
  if (!taskId) return;

  const task = readTaskRecord(cfg, taskId);
  if (!task) return;

  const resultStatus = (msg.metadata?.status as TaskStatus) || "DONE";
  updateTaskRecord(cfg, taskId, {
    status: resultStatus,
    completed_at: nowISO(),
    result_summary: msg.content.text.slice(0, 500),
    asset_paths: msg.metadata?.asset_paths ?? [],
  });
  logger.info(`Task ${taskId} result received from ${msg.from} (${resultStatus})`);
}

// ============================================================================
// ACK timeout monitoring
// ============================================================================

function monitorPendingTasks(cfg: ChatroomConfig, logger: Logger): void {
  const pending = listTasksByStatus(cfg, "DISPATCHED", "TIMEOUT");
  const now = Date.now();

  for (const task of pending) {
    if (task.from !== cfg.agentId) continue;

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

  const processing = listTasksByStatus(cfg, "ACKED", "PROCESSING");
  for (const task of processing) {
    if (task.from !== cfg.agentId) continue;
    const startedAt = new Date(task.started_at ?? task.acked_at ?? task.dispatched_at).getTime();
    if (now - startedAt > task.task_timeout_ms) {
      updateTaskRecord(cfg, task.task_id, { status: "FAILED", completed_at: nowISO() });
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

  const activeTasks = listTasksByStatus(cfg, "DISPATCHED", "ACKED", "PROCESSING");
  if (activeTasks.length > 0) {
    lines.push(`═══ Active Tasks ═══`);
    for (const t of activeTasks) {
      lines.push(
        `  - [${t.status}] ${t.task_id.slice(0, 8)}... → ${t.to}: "${t.instruction.slice(0, 60)}"`,
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
    `3. Your final TEXT RESPONSE is your task result.`,
    `   The system AUTOMATICALLY delivers it as a RESULT_REPORT to the orchestrator.`,
    `4. DO NOT send results via Lark, Feishu, or any other messaging channel.`,
    `   DO NOT call feishu tools, reply tools, or any messaging/notification tools.`,
    `   DO NOT attempt to notify anyone manually — the system handles ALL delivery.`,
    `5. Mention produced filenames in your text response so the orchestrator knows what was created.`,
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

  const dispatcherOptions = {
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    deliver: async (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;
      try {
        const producedFiles = scanOutputDir(outputDir as string);
        sendTaskResult(chatroomCfg, taskId, text, "DONE", logger, producedFiles);
      } catch (err) {
        logger.error(`Failed to send task result for ${taskId}: ${err}`);
      }
    },
    onError: (err: any, info: any) => {
      logger.error(`Task dispatch error for ${taskId} (${info?.kind}): ${err}`);
      try {
        sendTaskResult(chatroomCfg, taskId, `Task processing failed: ${err}`, "FAILED", logger);
      } catch {
        /* ignore */
      }
    },
  };

  logger.info(`Dispatching task ${taskId} to LLM`);

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions,
    replyOptions: {
      onModelSelected: prefixContext.onModelSelected,
      toolsDeny: ["message", "feishu_*", "lark_*"],
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
          }),
          async execute(_toolCallId, params) {
            try {
              const p = params as {
                target: string;
                instruction: string;
                timeout_minutes?: number;
              };
              const timeoutMs = (p.timeout_minutes ?? 60) * 60_000;
              const task = dispatchTask(cfg, p.target, p.instruction, logger, {
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

    // ── Background service ──────────────────────────────────────────────────

    const pollIntervalMs = (pluginCfg.pollIntervalMs as number) ?? 3000;
    const taskMonitorIntervalMs = (pluginCfg.taskMonitorIntervalMs as number) ?? 10_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let taskMonitorTimer: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "chatroom-daemon",
      start: async () => {
        logger.info(
          `Chatroom daemon started for agent=${agentId}, role=${cfg.role.toUpperCase()} (task protocol enabled)`,
        );
        updateHeartbeat(cfg);

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
                    // Also dispatch to LLM so orchestrator can relay to human
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
      },
      stop: async () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (pollTimer) clearInterval(pollTimer);
        if (taskMonitorTimer) clearInterval(taskMonitorTimer);
        logger.info("Chatroom daemon stopped");
      },
    });
  },
};

export default agentChatroomPlugin;
