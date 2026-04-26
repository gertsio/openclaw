export type EmailSenderOrigin = "automated" | "human" | "unknown";

export type ImportantEmailBucket = "urgent" | "digest" | "suppress" | "operational_failure";

export type ImportantEmailCategory =
  | "security"
  | "finance"
  | "legal_admin"
  | "deadline"
  | "logistics"
  | "account_access"
  | "work_opportunity"
  | "personal_action"
  | "newsletter"
  | "promotional_finance"
  | "noise"
  | "account_policy"
  | "operational";

export type ImportantEmailSuggestedAction =
  | "alert_owner"
  | "include_in_digest"
  | "suppress"
  | "repair_credentials"
  | "inspect_monitor";

export type NormalizedEmail = {
  accountId: string;
  messageId: string;
  threadId?: string;
  from?: string;
  senderOrigin?: EmailSenderOrigin;
  subject?: string;
  snippet?: string;
  bodyExcerpt?: string;
  labels?: string[];
  unread?: boolean;
  receivedAt?: string;
};

export type AccountImportancePolicy = {
  accountId: string;
  trustedSenders?: string[];
  noisySenders?: string[];
  watchedTerms?: string[];
  demotedTerms?: string[];
  escalationThreshold?: number;
  digestThreshold?: number;
};

export type ImportanceReason = {
  code: string;
  category: ImportantEmailCategory;
  detail: string;
  weight: number;
};

export type ImportantEmailDecision = {
  bucket: ImportantEmailBucket;
  score: number;
  confidence: "low" | "medium" | "high";
  categories: ImportantEmailCategory[];
  reasons: ImportanceReason[];
  suggestedAction: ImportantEmailSuggestedAction;
};

export type EmailMonitorMode = "urgent" | "digest" | "status" | "proactivity-review";

export type EmailMonitorDeliveryIntent = "send_alert" | "digest" | "suppress" | "none";
export type EmailMonitorDeliveryResult = "sent" | "suppressed" | "failed" | "not_attempted";

export type EmailMonitorDecisionRecord = {
  timestamp: string;
  mode: EmailMonitorMode;
  accountId: string;
  messageId?: string;
  threadId?: string;
  classifier: ImportantEmailDecision;
  deliveryIntent: EmailMonitorDeliveryIntent;
  deliveryResult: EmailMonitorDeliveryResult;
  reason: string;
};

export type EmailMonitorAccountResult =
  | {
      ok: true;
      accountId: string;
      checkedAt: string;
      considered: EmailMonitorDecisionRecord[];
    }
  | {
      ok: false;
      accountId: string;
      checkedAt: string;
      errorCode: EmailMonitorErrorCode;
      repairHint: string;
      considered: EmailMonitorDecisionRecord[];
    };

export type EmailMonitorErrorCode =
  | "gmail_cli_missing"
  | "gmail_auth_failed"
  | "gmail_token_storage_failed"
  | "gmail_access_failed"
  | "state_write_failed"
  | "invalid_output"
  | "unknown_error";

export type EmailMonitorRunResult = {
  ok: boolean;
  mode: EmailMonitorMode;
  checkedAt: string;
  accounts: EmailMonitorAccountResult[];
  summary: {
    accountsChecked: number;
    messagesConsidered: number;
    urgent: number;
    digest: number;
    suppressed: number;
    failedAccounts: number;
    dedupedAlerts: number;
  };
};
