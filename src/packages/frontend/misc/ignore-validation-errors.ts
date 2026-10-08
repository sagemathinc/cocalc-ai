/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Rejection handler for antd's form.validateFields(): an invalid form rejects
// with { errorFields }, which the form already shows next to the fields, so
// there is nothing more to report. Anything else is a real error and is
// rethrown. Without a handler, every invalid submit was logged as a crash.
export function ignoreValidationErrors(err: unknown): void {
  if (err != null && typeof err === "object" && "errorFields" in err) {
    return;
  }
  throw err;
}
