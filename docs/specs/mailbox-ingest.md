# Mailbox ingest

| Field | Value |
|-------|-------|
| **Slug** | `mailbox-ingest` |
| **Status** | `partial` |
| **Last reconciled** | 2026-08-19 |
| **Git SHA** | `18817990d33a1f3a970a44aae6567164358c86b8` |

## MVP boundary

**In:** Consent-first Gmail and Outlook connect, mailbox status, watch/sync, OAuth callbacks, provider webhooks.

**Out:** Arbitrary company data lakes, QuoteWerks, Drive/Slack ingest.

## Capability matrix

| Capability | Status | Contract | Data | Surface |
|------------|--------|----------|------|---------|
| Mailbox model | shipped | `src/signalData.ts` `MailboxProvider` `gmail \| outlook` | seed mailboxes | Admin / workspace |
| OAuth + webhooks | partial | `scripts/signal-api.mjs` `/api/oauth/*`, `/api/webhooks/gmail`, `/api/webhooks/outlook` | token vault | CLI `provider-launch` |
| Watch / sync | partial | `scripts/signal-provider-watch.mjs`, `signal-provider-sync.mjs` | sync cursors, email watch | scheduler |

## Gaps

| Gap | Severity | Evidence |
|-----|----------|----------|
| Production boot historically crash-looped on file-backed state | P0 closed on GH; re-prove compose | #161, #162, `0191671` |
| No non-mail sources | P3 by design | PRODUCT.md |

## Change log

| Date | SHA | Summary |
|------|-----|---------|
| 2026-08-19 | `1881799` | Initial reconcile |
