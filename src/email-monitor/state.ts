import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, safeParseJson, truncateUtf16Safe } from "../utils.js";
import type {
  EmailMonitorDecisionRecord,
  EmailMonitorDeliveryResult,
  EmailMonitorMode,
} from "./types.js";

export const DEFAULT_EMAIL_MONITOR_DIR = "email-monitor";
const SECRET_PATTERNS = [
  /ya29\.[A-Za-z0-9._-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(hook[-_ ]?token|push[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|password)["':=\s]+[^,\s"']+/gi,
];

export type EmailMonitorStatePaths = {
  decisionLogPath: string;
  dedupePath: string;
};

export type AlertDedupeState = {
  version: 1;
  alerted: Record<
    string,
    { alertedAt: string; accountId: string; messageId?: string; threadId?: string }
  >;
};

export function resolveEmailMonitorStatePaths(stateDir: string): EmailMonitorStatePaths {
  const root = path.join(stateDir, DEFAULT_EMAIL_MONITOR_DIR);
  return {
    decisionLogPath: path.join(root, "decisions.jsonl"),
    dedupePath: path.join(root, "alert-dedupe.json"),
  };
}

export function redactedDecisionRecord(
  record: EmailMonitorDecisionRecord,
): EmailMonitorDecisionRecord {
  return {
    ...record,
    reason: redactSensitiveText(record.reason),
    classifier: {
      ...record.classifier,
      reasons: record.classifier.reasons.map((reason) => ({
        ...reason,
        detail: redactSensitiveText(truncateUtf16Safe(reason.detail, 240)),
      })),
    },
  };
}

export function redactSensitiveText(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return truncateUtf16Safe(output, 500);
}

export async function appendDecisionRecords(
  logPath: string,
  records: EmailMonitorDecisionRecord[],
) {
  if (records.length === 0) {
    return;
  }
  await ensureDir(path.dirname(logPath));
  const lines = records.map((record) => JSON.stringify(redactedDecisionRecord(record))).join("\n");
  await fs.appendFile(logPath, `${lines}\n`, "utf8");
}

export async function loadRecentDecisionRecords(
  logPath: string,
  maxRecords = 200,
): Promise<EmailMonitorDecisionRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return raw
    .trim()
    .split("\n")
    .slice(-maxRecords)
    .map((line) => safeParseJson<EmailMonitorDecisionRecord>(line))
    .filter((record): record is EmailMonitorDecisionRecord => Boolean(record));
}

export async function loadAlertDedupeState(dedupePath: string): Promise<AlertDedupeState> {
  try {
    const parsed = safeParseJson<AlertDedupeState>(await fs.readFile(dedupePath, "utf8"));
    if (parsed?.version === 1 && parsed.alerted && typeof parsed.alerted === "object") {
      return parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  return { version: 1, alerted: {} };
}

export async function saveAlertDedupeState(dedupePath: string, state: AlertDedupeState) {
  await ensureDir(path.dirname(dedupePath));
  await fs.writeFile(dedupePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function alertDedupeKey(params: {
  accountId: string;
  messageId?: string;
  threadId?: string;
}): string {
  return [params.accountId, params.threadId ?? params.messageId ?? "unknown"].join(":");
}

export function markAlerted(params: {
  state: AlertDedupeState;
  accountId: string;
  messageId?: string;
  threadId?: string;
  alertedAt: string;
}) {
  params.state.alerted[
    alertDedupeKey({
      accountId: params.accountId,
      messageId: params.messageId,
      threadId: params.threadId,
    })
  ] = {
    alertedAt: params.alertedAt,
    accountId: params.accountId,
    messageId: params.messageId,
    threadId: params.threadId,
  };
}

export function wasAlerted(
  state: AlertDedupeState,
  params: { accountId: string; messageId?: string; threadId?: string },
): boolean {
  return Boolean(state.alerted[alertDedupeKey(params)]);
}

export function deliveryResultForBucket(params: {
  mode: EmailMonitorMode;
  bucket: string;
  alreadyAlerted: boolean;
}): EmailMonitorDeliveryResult {
  if (params.bucket === "urgent" && params.mode === "urgent") {
    return params.alreadyAlerted ? "suppressed" : "sent";
  }
  if (params.bucket === "digest" && params.mode === "digest") {
    return "sent";
  }
  if (params.bucket === "suppress") {
    return "suppressed";
  }
  return "not_attempted";
}
