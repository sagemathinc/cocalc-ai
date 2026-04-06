/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface RecentDocumentActivityEntry {
  id: string;
  project_id: string;
  path: string;
  last_accessed?: Date | null;
  recent_account_ids?: string[];
}
