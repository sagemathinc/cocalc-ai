/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type DiffPreviewSource =
  | { kind: "patch"; patch: string; label: string }
  | {
      kind: "documents";
      path: string;
      before: string;
      after: string;
      label: string;
    };
