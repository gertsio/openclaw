import type {
  AccountImportancePolicy,
  ImportantEmailBucket,
  ImportantEmailCategory,
  ImportantEmailDecision,
  ImportanceReason,
  NormalizedEmail,
} from "./types.js";

type Rule = {
  code: string;
  category: ImportantEmailCategory;
  terms: RegExp[];
  weight: number;
  detail: string;
};

const urgentRules: Rule[] = [
  {
    code: "security_access",
    category: "security",
    weight: 80,
    detail: "security or account access consequence",
    terms: [
      /suspicious sign[- ]?in/i,
      /password (?:reset|changed|expired)/i,
      /two[- ]?factor|2fa|mfa/i,
      /oauth|app permission|recovery code/i,
      /new device|unrecognized device/i,
    ],
  },
  {
    code: "finance_due",
    category: "finance",
    weight: 70,
    detail: "financial obligation or account consequence",
    terms: [
      /payment (?:failed|due|overdue|declined)/i,
      /card (?:declined|expired)/i,
      /bank alert|account disconnected/i,
      /invoice due|tax (?:notice|deadline|payment)/i,
    ],
  },
  {
    code: "legal_admin",
    category: "legal_admin",
    weight: 70,
    detail: "legal, compliance, or administrative notice",
    terms: [/registered agent/i, /compliance notice/i, /contract|signature required/i],
  },
  {
    code: "deadline_logistics",
    category: "deadline",
    weight: 70,
    detail: "time-sensitive deadline or logistics",
    terms: [
      /today|same[- ]?day|final reminder/i,
      /appointment|interview|meeting/i,
      /delivery (?:exception|attempt|today)/i,
    ],
  },
];

const digestRules: Rule[] = [
  {
    code: "work_opportunity",
    category: "work_opportunity",
    weight: 45,
    detail: "work or opportunity context",
    terms: [/proposal|opportunity|intro|follow[- ]?up/i],
  },
  {
    code: "personal_action",
    category: "personal_action",
    weight: 42,
    detail: "personal action requested",
    terms: [/please review|action required|needs your approval|respond by/i],
  },
  {
    code: "logistics",
    category: "logistics",
    weight: 36,
    detail: "logistics update worth reviewing",
    terms: [/tracking|shipment|reservation|itinerary/i],
  },
];

const demotionRules: Rule[] = [
  {
    code: "newsletter",
    category: "newsletter",
    weight: -45,
    detail: "newsletter or generic digest without clear consequence",
    terms: [/newsletter|weekly digest|roundup|top stories|unsubscribe/i],
  },
  {
    code: "promotional_finance",
    category: "promotional_finance",
    weight: -55,
    detail: "promotional finance offer",
    terms: [/pre[- ]?approved|loan offer|credit offer|cash advance|limited time apr/i],
  },
  {
    code: "marketing",
    category: "noise",
    weight: -35,
    detail: "marketing or promotional content",
    terms: [/sale|discount|deal ends|coupon|upgrade now/i],
  },
];

const DEFAULT_URGENT_THRESHOLD = 70;
const DEFAULT_DIGEST_THRESHOLD = 35;

export function classifyImportantEmail(
  email: NormalizedEmail,
  policy?: AccountImportancePolicy,
): ImportantEmailDecision {
  const text = searchableText(email);
  const reasons: ImportanceReason[] = [];

  collectRuleMatches(text, urgentRules, reasons);
  collectRuleMatches(text, digestRules, reasons);
  collectRuleMatches(text, demotionRules, reasons);
  collectPolicyReasons(text, email, policy, reasons);

  const score = clampScore(reasons.reduce((total, reason) => total + reason.weight, 0));
  const urgentThreshold = policy?.escalationThreshold ?? DEFAULT_URGENT_THRESHOLD;
  const digestThreshold = policy?.digestThreshold ?? DEFAULT_DIGEST_THRESHOLD;
  const bucket = resolveBucket(score, urgentThreshold, digestThreshold, reasons);
  const categories = Array.from(new Set(reasons.map((reason) => reason.category)));

  return {
    bucket,
    score,
    confidence:
      score >= urgentThreshold || score <= 10
        ? "high"
        : score >= digestThreshold
          ? "medium"
          : "low",
    categories,
    reasons,
    suggestedAction:
      bucket === "urgent" ? "alert_owner" : bucket === "digest" ? "include_in_digest" : "suppress",
  };
}

function resolveBucket(
  score: number,
  urgentThreshold: number,
  digestThreshold: number,
  reasons: ImportanceReason[],
): ImportantEmailBucket {
  const hasConsequentialReason = reasons.some((reason) => reason.weight >= 50);
  if (score >= urgentThreshold && hasConsequentialReason) {
    return "urgent";
  }
  if (score >= digestThreshold) {
    return "digest";
  }
  return "suppress";
}

function collectRuleMatches(text: string, rules: Rule[], reasons: ImportanceReason[]) {
  for (const rule of rules) {
    if (rule.terms.some((term) => term.test(text))) {
      reasons.push({
        code: rule.code,
        category: rule.category,
        detail: rule.detail,
        weight: rule.weight,
      });
    }
  }
}

function collectPolicyReasons(
  text: string,
  email: NormalizedEmail,
  policy: AccountImportancePolicy | undefined,
  reasons: ImportanceReason[],
) {
  if (!policy) {
    return;
  }
  const sender = (email.from ?? "").toLowerCase();
  if (policy.trustedSenders?.some((pattern) => sender.includes(pattern.toLowerCase()))) {
    reasons.push({
      code: "trusted_sender",
      category: "account_policy",
      detail: "account policy trusts this sender as supporting context",
      weight: 18,
    });
  }
  if (policy.noisySenders?.some((pattern) => sender.includes(pattern.toLowerCase()))) {
    reasons.push({
      code: "noisy_sender",
      category: "account_policy",
      detail: "account policy marks this sender as noisy",
      weight: -35,
    });
  }
  for (const term of policy.watchedTerms ?? []) {
    if (text.includes(term.toLowerCase())) {
      reasons.push({
        code: "watched_term",
        category: "account_policy",
        detail: `account policy watched term: ${term}`,
        weight: 34,
      });
    }
  }
  for (const term of policy.demotedTerms ?? []) {
    if (text.includes(term.toLowerCase())) {
      reasons.push({
        code: "demoted_term",
        category: "account_policy",
        detail: `account policy demoted term: ${term}`,
        weight: -60,
      });
    }
  }
}

function searchableText(email: NormalizedEmail): string {
  return [email.from, email.subject, email.snippet, email.bodyExcerpt, ...(email.labels ?? [])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
