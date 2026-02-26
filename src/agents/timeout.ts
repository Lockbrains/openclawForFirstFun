import type { FirstClawConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 120;
const MAX_AGENT_TIMEOUT_SECONDS = 300;
const MAX_LONG_RUNNING_TIMEOUT_SECONDS = 3600;
const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

export type AgentTimeoutTier = "standard" | "long_running";

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

function ceilingForTier(tier: AgentTimeoutTier): number {
  return tier === "long_running" ? MAX_LONG_RUNNING_TIMEOUT_SECONDS : MAX_AGENT_TIMEOUT_SECONDS;
}

export function resolveAgentTimeoutSeconds(
  cfg?: FirstClawConfig,
  tier: AgentTimeoutTier = "standard",
): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.min(Math.max(seconds, 1), ceilingForTier(tier));
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: FirstClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
  tier?: AgentTimeoutTier;
}): number {
  const tier = opts.tier ?? "standard";
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const clampOverride = (valueMs: number) =>
    Math.min(Math.max(valueMs, minMs), MAX_SAFE_TIMEOUT_MS);
  const defaultMs = Math.min(
    Math.max(resolveAgentTimeoutSeconds(opts.cfg, tier) * 1000, minMs),
    ceilingForTier(tier) * 1000,
  );
  const NO_TIMEOUT_MS = MAX_SAFE_TIMEOUT_MS;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return clampOverride(overrideMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return clampOverride(overrideSeconds * 1000);
  }
  return defaultMs;
}
