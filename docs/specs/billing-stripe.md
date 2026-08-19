# Billing (Stripe)

| Field | Value |
|-------|-------|
| **Slug** | `billing-stripe` |
| **Status** | `partial` |
| **Last reconciled** | 2026-08-19 |
| **Git SHA** | `18817990d33a1f3a970a44aae6567164358c86b8` |

## MVP boundary

**In:** Checkout, portal, invoices, webhooks, overrides, payment lifecycle admin.

**Out:** Per-interaction agent meter (P5). Stripe as TROZLAN company SSoT (Robertphoto is still manual invoice — PORTFOLIO_REAL).

## Capability matrix

| Capability | Status | Contract | Data | Surface |
|------------|--------|----------|------|---------|
| Stripe webhook | shipped | `POST /api/webhooks/stripe` | billing domain | `signal-payment-provider.mjs` |
| Lifecycle types | shipped | `SubscriptionStatus`, invoices | JSON state | admin payments |
| Refund/amount bugs | closed in git | #158 #159 #156 | — | 2026-06 commits |

## Gaps

| Gap | Severity | Evidence |
|-----|----------|----------|
| No agent per-peek meter | P2 | P5 |
| No paying Signal tenant on record | P2 GTM | PORTFOLIO_REAL; do not invent MRR |

## Change log

| Date | SHA | Summary |
|------|-----|---------|
| 2026-08-19 | `1881799` | Initial reconcile |
