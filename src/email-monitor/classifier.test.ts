import { describe, expect, it } from "vitest";
import { classifyImportantEmail } from "./classifier.js";
import type { NormalizedEmail } from "./types.js";

function email(input: Partial<NormalizedEmail>): NormalizedEmail {
  return {
    accountId: "owner",
    messageId: input.messageId ?? "m1",
    senderOrigin: input.senderOrigin ?? "unknown",
    ...input,
  };
}

describe("important email classifier", () => {
  it("promotes automated security and account-access email by consequence", () => {
    const decision = classifyImportantEmail(
      email({
        from: "no-reply@example.com",
        senderOrigin: "automated",
        subject: "Suspicious sign-in from a new device",
        snippet: "Reset your password if this was not you.",
      }),
    );

    expect(decision.bucket).toBe("urgent");
    expect(decision.categories).toContain("security");
    expect(decision.reasons.map((reason) => reason.code)).toContain("security_access");
  });

  it("does not promote human-looking promotional mail by sender origin", () => {
    const decision = classifyImportantEmail(
      email({
        from: "Alex <alex@credit.example>",
        senderOrigin: "human",
        subject: "Pre-approved loan offer",
        snippet: "Limited time APR. Unsubscribe here.",
      }),
    );

    expect(decision.bucket).toBe("suppress");
    expect(decision.categories).toContain("promotional_finance");
  });

  it("separates finance, legal, deadline, newsletter, and promotional examples", () => {
    expect(
      classifyImportantEmail(
        email({ subject: "Payment failed for invoice due today", snippet: "Card declined." }),
      ).bucket,
    ).toBe("urgent");
    expect(
      classifyImportantEmail(
        email({ subject: "Registered agent compliance notice", snippet: "Signature required." }),
      ).categories,
    ).toContain("legal_admin");
    expect(
      classifyImportantEmail(
        email({
          subject: "Delivery attempt today",
          snippet: "Final reminder for same-day pickup.",
        }),
      ).bucket,
    ).toBe("urgent");
    expect(
      classifyImportantEmail(
        email({ subject: "Weekly digest", snippet: "Top stories. Unsubscribe." }),
      ).bucket,
    ).toBe("suppress");
    expect(
      classifyImportantEmail(
        email({ subject: "Credit offer", snippet: "Pre-approved cash advance." }),
      ).categories,
    ).toContain("promotional_finance");
  });

  it("applies account-specific watched and demoted terms", () => {
    const message = email({
      accountId: "consulting",
      from: "bot@platform.example",
      subject: "Workspace alert",
      snippet: "Acme contract needs review",
    });

    const watched = classifyImportantEmail(message, {
      accountId: "consulting",
      watchedTerms: ["acme contract"],
      escalationThreshold: 30,
    });
    const demoted = classifyImportantEmail(message, {
      accountId: "personal",
      demotedTerms: ["workspace alert"],
      watchedTerms: [],
    });

    expect(watched.bucket).toBe("urgent");
    expect(demoted.bucket).toBe("suppress");
  });
});
