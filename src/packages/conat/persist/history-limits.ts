/*
Limits that bound the history of a sync document (bounded history design r3,
§2.1, §3.2 and §4.5).  The persist server enforces them; clients never choose
them.

Each can be overridden by an environment variable, e.g., in tests or to raise a
limit on one server while production data is measured.
*/

const MiB = 1024 * 1024;

export interface HistoryLimits {
  // a snapshot record, e.g., the seed of a reset; at least the encoded size of
  // any document a client may hold (32 MiB)
  maxSnapshotBytes: number;
  // the records after the snapshot an open starts from
  maxSuffixBytes: number;
  // the number of those records
  maxOpenRecords: number;
  // archived history kept per stream; the oldest is dropped beyond these
  maxArchiveBytes: number;
  maxArchiveRecords: number;
  maxArchiveSegments: number;
  // archived epochs whose msg ids are kept, so a client can learn which of its
  // pending patches a reset included; older epochs answer "unknown"
  maxArchivedIdEpochs: number;
  // ids in one inclusion query
  maxInclusionIds: number;
}

export const DEFAULT_HISTORY_LIMITS: Readonly<HistoryLimits> = Object.freeze({
  maxSnapshotBytes: 40 * MiB,
  maxSuffixBytes: 16 * MiB,
  maxOpenRecords: 1000,
  maxArchiveBytes: 1024 * MiB,
  maxArchiveRecords: 100_000,
  maxArchiveSegments: 1000,
  maxArchivedIdEpochs: 2,
  maxInclusionIds: 1000,
});

const ENV: { [key in keyof HistoryLimits]: string } = {
  maxSnapshotBytes: "COCALC_HISTORY_MAX_SNAPSHOT_BYTES",
  maxSuffixBytes: "COCALC_HISTORY_MAX_SUFFIX_BYTES",
  maxOpenRecords: "COCALC_HISTORY_MAX_OPEN_RECORDS",
  maxArchiveBytes: "COCALC_HISTORY_MAX_ARCHIVE_BYTES",
  maxArchiveRecords: "COCALC_HISTORY_MAX_ARCHIVE_RECORDS",
  maxArchiveSegments: "COCALC_HISTORY_MAX_ARCHIVE_SEGMENTS",
  maxArchivedIdEpochs: "COCALC_HISTORY_MAX_ARCHIVED_ID_EPOCHS",
  maxInclusionIds: "COCALC_HISTORY_MAX_INCLUSION_IDS",
};

export function historyLimits(
  env: NodeJS.ProcessEnv = process.env,
): HistoryLimits {
  const limits = { ...DEFAULT_HISTORY_LIMITS };
  for (const key of Object.keys(ENV) as (keyof HistoryLimits)[]) {
    const raw = env[ENV[key]];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) {
      limits[key] = value;
    }
  }
  return limits;
}
