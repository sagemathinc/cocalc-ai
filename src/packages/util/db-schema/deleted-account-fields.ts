/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What account deletion does with each column of the accounts row.

Deleting an account keeps the row, since projects, logs, purchases, etc. refer
to it, but sets every column below to NULL: personal data, credentials, CRM
data, and per-user settings and state, which have no purpose after deletion.

Kept deliberately:
- identifiers, routing and audit: account_id, home_bay_id, created, deleted,
  deleted_at, owner_id (which account created this one via the API), ephemeral,
  last_active (an account that was active recently is not deleted by mistake),
  and the security state banned, banned_at, api_search_next_ms,
  api_key_issuance_sequence (so ids and limits are never reused);
- financial records, which the law requires keeping: stripe_customer_id,
  stripe_customer, stripe_usage_subscription, coupon_history,
  purchase_closing_day, min_balance, balance, monthly_collection;
- email_address_before_delete, for DELETED_ACCOUNT_EMAIL_RETENTION_DAYS
  (server/accounts/deleted-account-retention.ts), then cleared;
- salesloft_id, until the Salesloft person is deleted
  (server/salesloft/sync.ts removeDeletedUsers), which then clears it.

email_address and passports are cleared separately by the deletion itself.
*/

export const DELETED_ACCOUNT_CLEARED_FIELDS = [
  // personal data and credentials
  "display_name",
  "first_name",
  "last_name",
  "password_hash",
  "api_key",
  "profile",
  "ssh_keys",
  "lti_id",
  "lti_data",
  "created_by",
  "sign_up_usage_intent",
  "email_address_verified",
  "email_address_challenge",
  "email_address_problem",
  "org",
  "tags",
  "notes",
  // settings and per-user state
  "other_settings",
  "editor_settings",
  "terminal",
  "autosave",
  "evaluate_key",
  "font_size",
  "customize",
  "groups",
  "default_rootfs_image",
  "default_rootfs_image_gpu",
  "trusted_product_access",
  "trusted_product_access_reason",
  "unlisted",
  "tours",
  "unread_message_count",
  "last_message_summary",
  "email_daily_statements",
  "balance_alert",
  // transient billing controls (the financial records themselves are kept)
  "stripe_checkout_session",
  "auto_balance",
] as const;
