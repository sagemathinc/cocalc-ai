# Scheduled Collection Expiry Repair

This operator-only action repairs one future queued course collection whose
expiry precedes its scheduled run time. It does not reschedule or run a
collection. It cannot resurrect an expired job or modify a started job.

The RPC requires a fresh cookie-backed admin session for both preview and
commit, resolves the course project's authoritative bay, and checks ownership
again while holding the project row lock. The operation row is locked against
worker admission, cancellation and expiry maintenance. It must still be a
never-started, attempt-zero, undismissed `course-collect-assignment` routed to
the hub and scoped to that project. Already-due jobs are excluded.

Use read-only operation metadata to obtain the exact `updated_at`, `expires_at`
and scheduled `input.run_at`. Then preview with a stable logical retry key:

```sh
cocalc admin db repair-scheduled-collection-expiry \
  --project-id <project-uuid> --op-id <operation-uuid> \
  --expected-updated-at <reviewed-iso> \
  --expected-expires-at <reviewed-iso> \
  --expected-run-at <reviewed-iso> \
  --idempotency-key <stable-repair-key> --reason '<approved repair reason>'
```

Review the response before repeating the same request with `--commit`.
The server computes the new expiry as seven days after the unchanged scheduled
run time. There is no arbitrary expiry parameter. Input, deduplication, status,
submission times, grades and files are unchanged.

After committing, independently read `admin db lro --op-id <operation-uuid>`
on the returned authoritative bay and compare `expires_at` and `updated_at`
with the receipt. A durable actor-scoped audit/idempotency receipt is committed
in the same transaction as the expiry update. Retries with the same key and
request return that original receipt; changing the request under the same key
is rejected. A replay is historical evidence, not a new current-state read.
Timeouts are uncertain outcomes: reconcile the receipt and operation rather
than canceling, rescheduling or using another key.

Deployment and each production repair require their own authorization. Merely
merging this tool does not repair any existing queued or expired operation.
