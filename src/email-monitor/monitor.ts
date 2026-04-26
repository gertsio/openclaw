import { spawn } from "node:child_process";
import { CONFIG_DIR, safeParseJson } from "../utils.js";
import { classifyImportantEmail } from "./classifier.js";
import {
  appendDecisionRecords,
  deliveryResultForBucket,
  loadAlertDedupeState,
  markAlerted,
  resolveEmailMonitorStatePaths,
  saveAlertDedupeState,
  wasAlerted,
} from "./state.js";
import type {
  AccountImportancePolicy,
  EmailMonitorAccountResult,
  EmailMonitorDecisionRecord,
  EmailMonitorDeliveryIntent,
  EmailMonitorErrorCode,
  EmailMonitorMode,
  EmailMonitorRunResult,
  NormalizedEmail,
} from "./types.js";

export type GmailMonitorClient = {
  listMessages(accountId: string): Promise<NormalizedEmail[]>;
};

export type RunEmailMonitorOptions = {
  mode: Exclude<EmailMonitorMode, "status" | "proactivity-review">;
  accounts: string[];
  policies?: AccountImportancePolicy[];
  client?: GmailMonitorClient;
  stateDir?: string;
  now?: () => Date;
};

export async function runEmailMonitor(
  options: RunEmailMonitorOptions,
): Promise<EmailMonitorRunResult> {
  const now = (options.now ?? (() => new Date()))();
  const checkedAt = now.toISOString();
  const statePaths = resolveEmailMonitorStatePaths(options.stateDir ?? CONFIG_DIR);
  const dedupeState = await loadAlertDedupeState(statePaths.dedupePath);
  const client = options.client ?? new GogGmailMonitorClient();
  const policies = new Map((options.policies ?? []).map((policy) => [policy.accountId, policy]));
  const accounts: EmailMonitorAccountResult[] = [];
  let dedupeChanged = false;
  let dedupedAlerts = 0;

  for (const accountId of options.accounts) {
    const records: EmailMonitorDecisionRecord[] = [];
    try {
      const messages = await client.listMessages(accountId);
      for (const message of messages) {
        const classifier = classifyImportantEmail(message, policies.get(accountId));
        const alreadyAlerted =
          classifier.bucket === "urgent" &&
          wasAlerted(dedupeState, {
            accountId,
            messageId: message.messageId,
            threadId: message.threadId,
          });
        const deliveryResult = deliveryResultForBucket({
          mode: options.mode,
          bucket: classifier.bucket,
          alreadyAlerted,
        });
        if (alreadyAlerted) {
          dedupedAlerts += 1;
        }
        if (classifier.bucket === "urgent" && deliveryResult === "sent") {
          markAlerted({
            state: dedupeState,
            accountId,
            messageId: message.messageId,
            threadId: message.threadId,
            alertedAt: checkedAt,
          });
          dedupeChanged = true;
        }
        records.push({
          timestamp: checkedAt,
          mode: options.mode,
          accountId,
          messageId: message.messageId,
          threadId: message.threadId,
          classifier,
          deliveryIntent: deliveryIntentFor(options.mode, classifier.bucket),
          deliveryResult,
          reason: summarizeDecision(classifier.reasons.map((reason) => reason.code)),
        });
      }
      await appendDecisionRecords(statePaths.decisionLogPath, records);
      accounts.push({ ok: true, accountId, checkedAt, considered: records });
    } catch (err) {
      const errorCode = classifyMonitorError(err);
      const failure = buildFailureRecord({
        checkedAt,
        accountId,
        mode: options.mode,
        errorCode,
        message: errorMessage(err),
      });
      await appendDecisionRecords(statePaths.decisionLogPath, [failure]);
      accounts.push({
        ok: false,
        accountId,
        checkedAt,
        errorCode,
        repairHint: repairHintFor(errorCode),
        considered: [failure],
      });
    }
  }

  if (dedupeChanged) {
    await saveAlertDedupeState(statePaths.dedupePath, dedupeState);
  }

  return buildRunResult({
    mode: options.mode,
    checkedAt,
    accounts,
    dedupedAlerts,
  });
}

function buildRunResult(params: {
  mode: RunEmailMonitorOptions["mode"];
  checkedAt: string;
  accounts: EmailMonitorAccountResult[];
  dedupedAlerts: number;
}): EmailMonitorRunResult {
  const considered = params.accounts.flatMap((account) => account.considered);
  return {
    ok: params.accounts.every((account) => account.ok),
    mode: params.mode,
    checkedAt: params.checkedAt,
    accounts: params.accounts,
    summary: {
      accountsChecked: params.accounts.length,
      messagesConsidered: considered.filter((record) => record.messageId).length,
      urgent: considered.filter((record) => record.classifier.bucket === "urgent").length,
      digest: considered.filter((record) => record.classifier.bucket === "digest").length,
      suppressed: considered.filter((record) => record.classifier.bucket === "suppress").length,
      failedAccounts: params.accounts.filter((account) => !account.ok).length,
      dedupedAlerts: params.dedupedAlerts,
    },
  };
}

function deliveryIntentFor(
  mode: RunEmailMonitorOptions["mode"],
  bucket: string,
): EmailMonitorDeliveryIntent {
  if (bucket === "urgent" && mode === "urgent") {
    return "send_alert";
  }
  if (bucket === "digest" && mode === "digest") {
    return "digest";
  }
  if (bucket === "suppress") {
    return "suppress";
  }
  return "none";
}

function summarizeDecision(codes: string[]): string {
  return codes.length > 0 ? codes.join(", ") : "no consequential action signal";
}

function buildFailureRecord(params: {
  checkedAt: string;
  accountId: string;
  mode: RunEmailMonitorOptions["mode"];
  errorCode: EmailMonitorErrorCode;
  message: string;
}): EmailMonitorDecisionRecord {
  return {
    timestamp: params.checkedAt,
    mode: params.mode,
    accountId: params.accountId,
    classifier: {
      bucket: "operational_failure",
      score: 100,
      confidence: "high",
      categories: ["operational"],
      reasons: [
        {
          code: params.errorCode,
          category: "operational",
          detail: params.message,
          weight: 100,
        },
      ],
      suggestedAction: "repair_credentials",
    },
    deliveryIntent: "none",
    deliveryResult: "failed",
    reason: `${params.errorCode}: ${params.message}`,
  };
}

function classifyMonitorError(err: unknown): EmailMonitorErrorCode {
  const message = errorMessage(err).toLowerCase();
  if (message.includes("enoent") || message.includes("not found")) {
    return "gmail_cli_missing";
  }
  if (message.includes("oauth") || message.includes("auth") || message.includes("credential")) {
    return "gmail_auth_failed";
  }
  if (message.includes("token") || message.includes("keyring")) {
    return "gmail_token_storage_failed";
  }
  if (message.includes("json")) {
    return "invalid_output";
  }
  return "gmail_access_failed";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function repairHintFor(code: EmailMonitorErrorCode): string {
  switch (code) {
    case "gmail_cli_missing":
      return "Install or restore the Gmail CLI layer and rerun the monitor.";
    case "gmail_auth_failed":
      return "Repair Gmail OAuth credentials for this account, then rerun live verification.";
    case "gmail_token_storage_failed":
      return "Verify token storage is on durable Railway storage and re-consent if needed.";
    default:
      return "Inspect Gmail CLI access and monitor logs; browser inbox automation is not a normal fallback.";
  }
}

export class GogGmailMonitorClient implements GmailMonitorClient {
  async listMessages(accountId: string): Promise<NormalizedEmail[]> {
    const result = await runGogJson(["gmail", "list", "--account", accountId, "--json"]);
    const parsed = safeParseJson<unknown>(result);
    if (!Array.isArray(parsed)) {
      throw new Error("invalid JSON from gog gmail list");
    }
    return parsed.map((raw) => normalizeGogMessage(accountId, raw));
  }
}

function normalizeGogMessage(accountId: string, raw: unknown): NormalizedEmail {
  const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const messageId = stringField(item, "messageId") ?? stringField(item, "id") ?? "unknown";
  return {
    accountId,
    messageId,
    threadId: stringField(item, "threadId"),
    from: stringField(item, "from") ?? stringField(item, "sender"),
    senderOrigin: parseSenderOrigin(stringField(item, "senderOrigin")),
    subject: stringField(item, "subject"),
    snippet: stringField(item, "snippet"),
    bodyExcerpt: stringField(item, "body") ?? stringField(item, "bodyExcerpt"),
    labels: Array.isArray(item.labels)
      ? item.labels.filter((label): label is string => typeof label === "string")
      : undefined,
    unread: typeof item.unread === "boolean" ? item.unread : undefined,
    receivedAt: stringField(item, "receivedAt") ?? stringField(item, "date"),
  };
}

function parseSenderOrigin(value: string | undefined): NormalizedEmail["senderOrigin"] {
  return value === "automated" || value === "human" || value === "unknown" ? value : "unknown";
}

function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function runGogJson(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("gog", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || stdout || `gog exited with ${code}`));
    });
  });
}
