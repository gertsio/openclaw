# Consequence-Based Email Monitor

The Important Email classifier judges email by consequence, urgency, and actionability. Sender origin is supporting metadata only. Automated messages can be urgent when they affect security, money, legal status, access, deadlines, logistics, or real work opportunities. Human-looking messages can still be noise when they are promotional, generic, or unactionable.

## Classifier Contract

The monitor normalizes Gmail items into account id, message id, thread id, sender, sender origin, subject, snippet, optional body excerpt, labels, unread state, and received timestamp. The classifier returns:

- `bucket`: `urgent`, `digest`, `suppress`, or `operational_failure`
- `score` and `confidence`
- reason labels with categories such as security, finance, legal/admin, deadline, logistics, account access, newsletter, and promotional finance
- `suggestedAction`: alert, include in digest, suppress, repair credentials, or inspect monitor

Account policy is a separate input from cron prompts and schedules. Policies can supply trusted senders, noisy senders, watched terms, demoted terms, and escalation or digest thresholds. Policy nudges classification, but the decision still comes from consequence and actionability rather than sender origin alone.

## Script-Backed Runs

Hourly urgent checks should call:

```bash
openclaw webhooks gmail monitor --accounts owner@example.com,work@example.com
```

Morning summaries should call:

```bash
openclaw webhooks gmail digest --accounts owner@example.com,work@example.com
```

Both commands return structured JSON with per-account status, considered message and thread ids, classifier decisions, delivery intent, delivery result, and operational errors. A cron run is healthy only when the command executes successfully and the JSON result reports monitor success. This separates cron success, Gmail access success, classifier decisions, and delivery success.

The status path reads decision logs and is suitable for mobile or SSH inspection:

```bash
openclaw webhooks gmail status
```

## Decision Logs And Dedupe State

Decision logs are append-only JSONL records under OpenClaw state, in `email-monitor/decisions.jsonl`. Records include timestamp, mode, account, message or thread identity, classifier result, delivery intent, delivery result, and a concise reason.

Urgent alert deduplication is stored separately in `email-monitor/alert-dedupe.json`. The dedupe file answers whether a message or thread already interrupted the Owner. Decision logs answer what happened and why. Successful urgent delivery marks a message or thread alerted; failed delivery does not.

Logs redact common OAuth tokens, bearer tokens, hook tokens, push tokens, access tokens, refresh tokens, and passwords. Raw secrets and full message bodies should not be written to repository-managed files, docs, issues, or logs.

## Credential And Token Failures

OAuth, token storage, Gmail CLI, and access failures fail closed as structured monitor failures. The monitor reports repair-oriented reasons and does not fall back to browser inbox automation or invented summaries.

On Railway, Gmail token storage must live on durable state that survives restarts. If token storage is missing, ephemeral, or unreadable, repair the mounted storage or re-consent the Gmail account, then rerun live verification through the Gmail CLI layer.

## Optional Pub/Sub Trigger Tier

Gmail Pub/Sub remains optional and is not enabled globally by this monitor work. Selected critical inboxes can later use Pub/Sub as a lower-latency trigger, but Pub/Sub-triggered runs should reuse the same normalized input model, classifier, decision log, dedupe state, and delivery behavior as cron-triggered runs.

Do not change Railway infrastructure, Gmail scopes, credentials, domains, volumes, or runtime config for Pub/Sub without explicit operator approval.
