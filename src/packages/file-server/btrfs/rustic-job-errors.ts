/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A timeout is not evidence that a privileged worker has stopped. Callers must
// retain staging data when the independent cleanup barrier cannot prove exit.
export class RusticJobCleanupError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      `Rustic job termination could not be verified; staging must be retained: ${cause}`,
    );
    this.name = "RusticJobCleanupError";
  }
}
