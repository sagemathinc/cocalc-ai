/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button } from "antd";

interface Props {
  error: string;
  onRetry: () => void;
}

export function OrganizationSaveAlert({ error, onRetry }: Props) {
  if (!error) return null;
  return (
    <Alert
      role="alert"
      type="error"
      showIcon
      title={error}
      description="Your changes are still shown here, but may be lost if you reload this page."
      action={
        <Button size="small" onClick={onRetry}>
          Retry save
        </Button>
      }
    />
  );
}
