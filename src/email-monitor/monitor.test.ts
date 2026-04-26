import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEmailMonitor, type GmailMonitorClient } from "./monitor.js";
import { loadRecentDecisionRecords, resolveEmailMonitorStatePaths } from "./state.js";
import { summarizeStatus } from "./status.js";
import type { NormalizedEmail } from "./types.js";

class FakeClient implements GmailMonitorClient {
  constructor(private readonly messagesByAccount: Record<string, NormalizedEmail[]>) {}

  async listMessages(accountId: string): Promise<NormalizedEmail[]> {
    const value = this.messagesByAccount[accountId];
    if (value instanceof Error) {
      throw value;
    }
    return value ?? [];
  }
}

describe("email monitor", () => {
  it("returns structured urgent output, writes redacted decisions, and dedupes restarts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-email-monitor-"));
    const client = new FakeClient({
      owner: [
        {
          accountId: "owner",
          messageId: "m1",
          threadId: "t1",
          senderOrigin: "automated",
          subject: "Suspicious sign-in",
          snippet: "Bearer ya29.secret should never leak",
        },
      ],
    });

    const first = await runEmailMonitor({
      mode: "urgent",
      accounts: ["owner"],
      client,
      stateDir,
      now: () => new Date("2026-04-24T10:00:00Z"),
    });
    const second = await runEmailMonitor({
      mode: "urgent",
      accounts: ["owner"],
      client,
      stateDir,
      now: () => new Date("2026-04-24T11:00:00Z"),
    });

    expect(first.summary.urgent).toBe(1);
    expect(first.accounts[0]?.considered[0]?.deliveryResult).toBe("sent");
    expect(second.summary.dedupedAlerts).toBe(1);
    expect(second.accounts[0]?.considered[0]?.deliveryResult).toBe("suppressed");

    const paths = resolveEmailMonitorStatePaths(stateDir);
    const rawLog = await fs.readFile(paths.decisionLogPath, "utf8");
    expect(rawLog).not.toContain("ya29.secret");
    const records = await loadRecentDecisionRecords(paths.decisionLogPath);
    expect(records).toHaveLength(2);
  });

  it("records credential failures as closed operational failures", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-email-monitor-"));
    const client: GmailMonitorClient = {
      async listMessages() {
        throw new Error("OAuth credential expired");
      },
    };

    const result = await runEmailMonitor({
      mode: "urgent",
      accounts: ["owner"],
      client,
      stateDir,
    });

    expect(result.ok).toBe(false);
    expect(result.accounts[0]?.ok).toBe(false);
    expect(result.accounts[0]?.considered[0]?.classifier.bucket).toBe("operational_failure");
    expect(result.accounts[0]?.considered[0]?.deliveryResult).toBe("failed");
  });

  it("builds status from decision records", () => {
    const status = summarizeStatus([
      {
        timestamp: "2026-04-24T10:00:00Z",
        mode: "urgent",
        accountId: "owner",
        messageId: "m1",
        classifier: {
          bucket: "urgent",
          score: 90,
          confidence: "high",
          categories: ["security"],
          reasons: [],
          suggestedAction: "alert_owner",
        },
        deliveryIntent: "send_alert",
        deliveryResult: "sent",
        reason: "security_access",
      },
      {
        timestamp: "2026-04-24T11:00:00Z",
        mode: "digest",
        accountId: "owner",
        messageId: "m2",
        classifier: {
          bucket: "digest",
          score: 40,
          confidence: "medium",
          categories: ["personal_action"],
          reasons: [],
          suggestedAction: "include_in_digest",
        },
        deliveryIntent: "digest",
        deliveryResult: "sent",
        reason: "personal_action",
      },
    ]);

    expect(status.ok).toBe(true);
    expect(status.lastUrgentCheck).toBe("2026-04-24T10:00:00Z");
    expect(status.lastDigestCheck).toBe("2026-04-24T11:00:00Z");
    expect(status.accounts.owner?.recentUrgent).toBe(1);
    expect(status.accounts.owner?.recentDigest).toBe(1);
  });
});
