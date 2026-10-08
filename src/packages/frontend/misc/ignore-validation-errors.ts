/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Rejection handler for antd's form.validateFields(): an invalid form rejects
// with { values, errorFields: [{ name, errors }, ...], outOfDate }, which the
// form already shows next to the fields, so there is nothing more to report.
// Anything else is a real error and is rethrown. Without a handler, every
// invalid submit was logged as a crash.
export function ignoreValidationErrors(err: unknown): void {
  if (isAntdValidationError(err)) {
    return;
  }
  throw err;
}

function isAntdValidationError(err: unknown): boolean {
  if (err == null || typeof err !== "object" || err instanceof Error) {
    return false;
  }
  const { errorFields } = err as { errorFields?: unknown };
  return (
    Array.isArray(errorFields) &&
    errorFields.every(
      (field) =>
        field != null &&
        typeof field === "object" &&
        Array.isArray((field as { errors?: unknown }).errors),
    )
  );
}
