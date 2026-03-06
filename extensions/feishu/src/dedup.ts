import os from "node:os";
import path from "node:path";
import { createDedupeCache, createPersistentDedupe } from "openclaw/plugin-sdk";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const FILE_MAX_ENTRIES = 10_000;

const memoryDedupe = createDedupeCache({ ttlMs: DEDUP_TTL_MS, maxSize: MEMORY_MAX_SIZE });

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveNamespaceFilePath(namespace: string): string {
  // Support both legacy single-file (accountId) and new per-agent dedup
  // For backward compatibility: if namespace contains "default", keep using single file
  // New format: dedup/{agentId}.json for multi-bot broadcast
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dedupDir = path.join(resolveStateDirFromEnv(), "feishu", "dedup");

  // If it's a known accountId (legacy), use single file; otherwise use agent-specific
  const legacyAccounts = ["default", "b", "c", "d", "e", "f"];
  if (legacyAccounts.includes(namespace)) {
    return path.join(dedupDir, `${safe}.json`);
  }
  // New: use agent-specific dedup file
  return path.join(dedupDir, `${safe}.json`);
}

const persistentDedupe = createPersistentDedupe({
  ttlMs: DEDUP_TTL_MS,
  memoryMaxSize: MEMORY_MAX_SIZE,
  fileMaxEntries: FILE_MAX_ENTRIES,
  resolveFilePath: resolveNamespaceFilePath,
});

/**
 * Synchronous dedup — memory only.
 * Kept for backward compatibility; prefer {@link tryRecordMessagePersistent}.
 */
export function tryRecordMessage(messageId: string): boolean {
  return !memoryDedupe.check(messageId);
}

export async function tryRecordMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  return persistentDedupe.checkAndRecord(messageId, {
    namespace,
    onDiskError: (error) => {
      log?.(`feishu-dedup: disk error, falling back to memory: ${String(error)}`);
    },
  });
}
