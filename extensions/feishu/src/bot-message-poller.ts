/**
 * Bot message poller for Feishu multi-bot group collaboration.
 *
 * Feishu's event subscription (`im.message.receive_v1`) only delivers messages
 * from human users — bot-sent messages are invisible to other bots.
 *
 * This module periodically polls `im/v1/messages` for configured group chats,
 * finds messages sent by OTHER bots that mention THIS agent by name, and feeds
 * them into the standard `handleFeishuMessage` pipeline.
 *
 * IMPORTANT time-unit note (from Feishu docs):
 * - `start_time` / `end_time` query params: Unix seconds (string)
 * - Response `create_time`: Unix **milliseconds** (string)
 */
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "firstclaw/plugin-sdk";
import type { ResolvedFeishuAccount, FeishuConfig } from "./types.js";
import { createFeishuClient } from "./client.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * Per-chat high-water mark stored in **seconds** (matching the API query param unit).
 * After each successful poll we advance this to the newest message's create_time
 * converted from milliseconds to seconds.
 */
const lastSeenSeconds = new Map<string, number>();

/** Dedup set to avoid processing the same message twice across polls. */
const processedPolledIds = new Set<string>();
const POLLED_DEDUP_MAX = 2_000;

function prunePolledDedup() {
  if (processedPolledIds.size > POLLED_DEDUP_MAX) {
    const iter = processedPolledIds.values();
    const toRemove = Math.floor(processedPolledIds.size / 2);
    for (let i = 0; i < toRemove; i++) {
      const val = iter.next().value;
      if (val !== undefined) processedPolledIds.delete(val);
    }
  }
}

/** Convert create_time (milliseconds string) → seconds number. */
function createTimeToSeconds(createTimeMs: string): number {
  const ms = Number(createTimeMs);
  if (Number.isNaN(ms)) return 0;
  // Heuristic: if the value is clearly already in seconds (< 2e10 ≈ year 2603),
  // the API returned seconds directly; otherwise divide by 1000.
  return ms > 2e10 ? Math.floor(ms / 1000) : Math.floor(ms);
}

type ListMessagesResponse = {
  code?: number;
  msg?: string;
  data?: {
    items?: Array<{
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      chat_id?: string;
      msg_type?: string;
      body?: { content?: string };
      sender?: {
        id: string;
        id_type: string;
        sender_type: string;
        tenant_key?: string;
      };
      mentions?: Array<{
        key: string;
        id: string;
        id_type: string;
        name: string;
        tenant_key?: string;
      }>;
      create_time?: string;
      deleted?: boolean;
    }>;
    has_more?: boolean;
    page_token?: string;
  };
};

/**
 * Poll one group chat for recent bot messages.
 */
async function pollGroupChat(params: {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  botOpenId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
}): Promise<void> {
  const { cfg, account, chatId, botOpenId, runtime, chatHistories } = params;
  const log = runtime?.log ?? console.log;
  const client = createFeishuClient(account);

  const startSec = lastSeenSeconds.get(chatId) ?? Math.floor(Date.now() / 1000) - 30;
  const endSec = Math.floor(Date.now() / 1000);

  // Feishu requires start_time and end_time together, gap ≤ 1 day.
  const startTimeStr = String(startSec);
  const endTimeStr = String(endSec);

  try {
    const response = (await client.im.message.list({
      params: {
        container_id_type: "chat",
        container_id: chatId,
        start_time: startTimeStr,
        end_time: endTimeStr,
        page_size: 50,
        sort_type: "ByCreateTimeAsc",
      },
    })) as ListMessagesResponse;

    if (response.code !== 0) {
      log(
        `feishu-poller[${account.accountId}]: list messages error for ${chatId}: code=${response.code} msg=${response.msg ?? ""}`,
      );
      return;
    }

    const items = response.data?.items ?? [];

    // Advance high-water mark regardless of whether we found bot messages.
    // Use the newest item's create_time, or fall back to current time.
    if (items.length > 0) {
      const lastItem = items[items.length - 1];
      if (lastItem?.create_time) {
        const newMark = createTimeToSeconds(lastItem.create_time);
        if (newMark > 0) {
          // +1 so next poll starts AFTER this message (avoid re-fetching it)
          lastSeenSeconds.set(chatId, newMark + 1);
        }
      }
    } else {
      // No messages in window — just advance to now so the window doesn't grow unbounded.
      lastSeenSeconds.set(chatId, endSec);
    }

    let botMsgCount = 0;

    for (const item of items) {
      const msgId = item.message_id;
      if (!msgId) continue;
      if (item.deleted) continue;
      if (processedPolledIds.has(msgId)) continue;

      // Only process messages from OTHER bots (sender_type === "app")
      if (item.sender?.sender_type !== "app") continue;

      // Skip messages from THIS bot
      const senderOpenId = item.sender?.id_type === "open_id" ? item.sender?.id : undefined;
      if (senderOpenId && senderOpenId === botOpenId) continue;

      processedPolledIds.add(msgId);
      prunePolledDedup();
      botMsgCount++;

      // Construct a synthetic FeishuMessageEvent
      const syntheticEvent: FeishuMessageEvent = {
        sender: {
          sender_id: {
            open_id: senderOpenId ?? item.sender?.id ?? "",
          },
          sender_type: "app",
          tenant_key: item.sender?.tenant_key,
        },
        message: {
          message_id: msgId,
          root_id: item.root_id,
          parent_id: item.parent_id,
          chat_id: item.chat_id ?? chatId,
          chat_type: "group",
          message_type: item.msg_type ?? "text",
          content: item.body?.content ?? "",
          mentions: item.mentions?.map((m) => ({
            key: m.key,
            id: {
              open_id: m.id_type === "open_id" ? m.id : undefined,
              user_id: m.id_type === "user_id" ? m.id : undefined,
            },
            name: m.name,
            tenant_key: m.tenant_key,
          })),
        },
      };

      log(
        `feishu-poller[${account.accountId}]: processing bot message ${msgId} in ${chatId} from ${senderOpenId ?? "unknown-app"}`,
      );

      try {
        await handleFeishuMessage({
          cfg,
          event: syntheticEvent,
          botOpenId,
          runtime,
          chatHistories,
          accountId: account.accountId,
        });
      } catch (err) {
        log(
          `feishu-poller[${account.accountId}]: error handling polled message ${msgId}: ${String(err)}`,
        );
      }
    }

    if (botMsgCount > 0) {
      log(
        `feishu-poller[${account.accountId}]: processed ${botMsgCount} bot message(s) from ${chatId} (window ${startTimeStr}–${endTimeStr})`,
      );
    }
  } catch (err) {
    log(
      `feishu-poller[${account.accountId}]: poll error for ${chatId}: ${String(err)}`,
    );
  }
}

export type BotMessagePollerParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  botOpenId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  abortSignal?: AbortSignal;
};

/**
 * Start the bot message poller for an account.
 * Runs in the background until the abort signal fires.
 */
export function startBotMessagePoller(params: BotMessagePollerParams): void {
  const { cfg, account, botOpenId, runtime, chatHistories, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const feishuCfg = account.config as FeishuConfig;
  const pollingCfg = feishuCfg.botMessagePolling;

  if (!pollingCfg?.enabled) return;

  const intervalMs = pollingCfg.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const groups = pollingCfg.groups ?? [];

  if (groups.length === 0) {
    const groupAllowFrom = feishuCfg.groupAllowFrom ?? [];
    for (const g of groupAllowFrom) {
      const id = String(g).trim();
      if (id && id !== "*") groups.push(id);
    }
  }

  if (groups.length === 0) {
    log(
      `feishu-poller[${account.accountId}]: botMessagePolling enabled but no groups to poll (set groups or groupAllowFrom)`,
    );
    return;
  }

  log(
    `feishu-poller[${account.accountId}]: starting (interval=${intervalMs}ms, groups=[${groups.join(", ")}], botOpenId=${botOpenId || "unknown"})`,
  );

  // Initialize high-water marks: start from 30s ago so we don't miss recent messages
  const nowSec = Math.floor(Date.now() / 1000);
  for (const chatId of groups) {
    if (!lastSeenSeconds.has(chatId)) {
      lastSeenSeconds.set(chatId, nowSec - 30);
    }
  }

  // Run first poll immediately, then on interval
  const runPoll = async () => {
    if (abortSignal?.aborted) return;
    for (const chatId of groups) {
      if (abortSignal?.aborted) break;
      await pollGroupChat({
        cfg,
        account,
        chatId,
        botOpenId,
        runtime,
        chatHistories,
      });
    }
  };

  // Immediate first poll
  runPoll().catch((err) => {
    log(`feishu-poller[${account.accountId}]: initial poll error: ${String(err)}`);
  });

  const timer = setInterval(() => {
    runPoll().catch((err) => {
      log(`feishu-poller[${account.accountId}]: poll cycle error: ${String(err)}`);
    });
  }, intervalMs);

  // Clean up on abort
  if (abortSignal) {
    const handleAbort = () => {
      clearInterval(timer);
      log(`feishu-poller[${account.accountId}]: stopped`);
    };
    if (abortSignal.aborted) {
      clearInterval(timer);
    } else {
      abortSignal.addEventListener("abort", handleAbort, { once: true });
    }
  }
}
