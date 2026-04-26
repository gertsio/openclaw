import { CONFIG_DIR } from "../utils.js";
import { loadRecentDecisionRecords, resolveEmailMonitorStatePaths } from "./state.js";
import type { EmailMonitorDecisionRecord } from "./types.js";

export type EmailMonitorStatusSummary = {
  ok: boolean;
  lastUrgentCheck?: string;
  lastDigestCheck?: string;
  accounts: Record<
    string,
    {
      lastCheck?: string;
      lastFailure?: string;
      recentUrgent: number;
      recentDigest: number;
      recentSuppressed: number;
    }
  >;
  recentFailures: Array<{ timestamp: string; accountId: string; reason: string }>;
};

export async function buildEmailMonitorStatus(params?: {
  stateDir?: string;
  maxRecords?: number;
}): Promise<EmailMonitorStatusSummary> {
  const paths = resolveEmailMonitorStatePaths(params?.stateDir ?? CONFIG_DIR);
  const records = await loadRecentDecisionRecords(paths.decisionLogPath, params?.maxRecords ?? 200);
  return summarizeStatus(records);
}

export function summarizeStatus(records: EmailMonitorDecisionRecord[]): EmailMonitorStatusSummary {
  const accounts: EmailMonitorStatusSummary["accounts"] = {};
  let lastUrgentCheck: string | undefined;
  let lastDigestCheck: string | undefined;
  const recentFailures: EmailMonitorStatusSummary["recentFailures"] = [];

  for (const record of records) {
    const current =
      accounts[record.accountId] ??
      (accounts[record.accountId] = {
        recentUrgent: 0,
        recentDigest: 0,
        recentSuppressed: 0,
      });
    current.lastCheck = maxIso(current.lastCheck, record.timestamp);
    if (record.mode === "urgent") {
      lastUrgentCheck = maxIso(lastUrgentCheck, record.timestamp);
    }
    if (record.mode === "digest") {
      lastDigestCheck = maxIso(lastDigestCheck, record.timestamp);
    }
    if (record.classifier.bucket === "urgent") {
      current.recentUrgent += 1;
    } else if (record.classifier.bucket === "digest") {
      current.recentDigest += 1;
    } else if (record.classifier.bucket === "suppress") {
      current.recentSuppressed += 1;
    }
    if (record.deliveryResult === "failed" || record.classifier.bucket === "operational_failure") {
      current.lastFailure = record.reason;
      recentFailures.push({
        timestamp: record.timestamp,
        accountId: record.accountId,
        reason: record.reason,
      });
    }
  }

  return {
    ok: recentFailures.length === 0,
    lastUrgentCheck,
    lastDigestCheck,
    accounts,
    recentFailures: recentFailures.slice(-20),
  };
}

export function buildNightlyProactivityReview(records: EmailMonitorDecisionRecord[]): {
  falsePositiveCandidates: Record<string, number>;
  digestRecoveredCandidates: string[];
  failures: string[];
} {
  const falsePositiveCandidates: Record<string, number> = {};
  const digestRecoveredCandidates: string[] = [];
  const failures: string[] = [];

  for (const record of records) {
    if (record.deliveryResult === "sent" && record.classifier.bucket === "urgent") {
      for (const reason of record.classifier.reasons) {
        falsePositiveCandidates[reason.code] = (falsePositiveCandidates[reason.code] ?? 0) + 1;
      }
    }
    if (record.mode === "digest" && record.classifier.bucket === "digest") {
      digestRecoveredCandidates.push(
        `${record.accountId}:${record.threadId ?? record.messageId ?? "unknown"}`,
      );
    }
    if (record.deliveryResult === "failed") {
      failures.push(`${record.accountId}: ${record.reason}`);
    }
  }

  return { falsePositiveCandidates, digestRecoveredCandidates, failures };
}

function maxIso(current: string | undefined, next: string): string {
  return !current || next > current ? next : current;
}
