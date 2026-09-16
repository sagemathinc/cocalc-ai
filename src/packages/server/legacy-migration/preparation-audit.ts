// Arguments are internal SQL expressions, never user input. Preserve audit
// events atomically without resurrecting a previous snapshot's prepared state.
export function preservePreparationAuditSql(
  previous: string,
  next: string,
): string {
  return `CASE WHEN jsonb_typeof(${previous}->'final_archive_remediation'->'prepare_events')='array'
    THEN jsonb_set(COALESCE(${next}, '{}'::jsonb), '{final_archive_remediation}',
      COALESCE((${next})->'final_archive_remediation', '{}'::jsonb) ||
      jsonb_build_object('prepare_events', ${previous}->'final_archive_remediation'->'prepare_events'), true)
    ELSE ${next} END`;
}
