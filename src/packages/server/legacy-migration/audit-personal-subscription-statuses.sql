-- Read-only predeployment audit for the active/canceled subscription migration.
-- Run this against production and record the output in the PR deployment note.
-- No account identifiers or other PII are selected.

SELECT
  COALESCE(s.status, '<NULL>') AS status,
  COALESCE(s.metadata->>'type', '<NULL>') AS metadata_type,
  COALESCE(s.metadata->>'class', '<NULL>') AS membership_class,
  COALESCE(s.interval, '<NULL>') AS billing_interval,
  COALESCE(s.payment->>'status', '<NULL>') AS payment_status,
  (s.current_period_end > NOW()) AS period_ends_in_future,
  (s.latest_purchase_id IS NOT NULL) AS has_latest_purchase,
  COUNT(*) AS subscription_count,
  MIN(s.created) AS earliest_created,
  MAX(s.created) AS latest_created
FROM subscriptions AS s
WHERE s.status IS NULL
   OR s.status IN ('unpaid', 'past_due')
GROUP BY
  s.status,
  s.metadata->>'type',
  s.metadata->>'class',
  s.interval,
  s.payment->>'status',
  (s.current_period_end > NOW()),
  (s.latest_purchase_id IS NOT NULL)
ORDER BY
  status,
  metadata_type,
  membership_class,
  billing_interval,
  payment_status,
  period_ends_in_future,
  has_latest_purchase;
