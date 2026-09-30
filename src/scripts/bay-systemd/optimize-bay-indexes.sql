-- Run with psql -v ON_ERROR_STOP=1, without --single-transaction, before the
-- normal schema migration on an existing bay. These names match the schema.
CREATE INDEX CONCURRENTLY IF NOT EXISTS project_events_outbox_project_history_idx
  ON project_events_outbox (project_id, created_at DESC, event_id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS project_events_outbox_collaborator_history_idx
  ON project_events_outbox (project_id, created_at DESC, event_id DESC)
  WHERE event_type IN ('project.created', 'project.membership_changed', 'project.deleted');
CREATE INDEX CONCURRENTLY IF NOT EXISTS projects_student_usage_account_idx
  ON projects ((course ->> 'account_id'))
  WHERE deleted IS NULL AND course ->> 'type' = 'student';

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE c.relname IN ('project_events_outbox_project_history_idx',
      'project_events_outbox_collaborator_history_idx', 'projects_student_usage_account_idx')
      AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'An optimization index is invalid; drop that index concurrently and retry';
  END IF;
END $$;
