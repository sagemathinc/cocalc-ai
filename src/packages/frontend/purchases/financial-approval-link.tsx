/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Modal, Typography } from "antd";
import type { ButtonProps } from "antd";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@cocalc/frontend/components/icon";

interface Props {
  approvalUrl: string;
  children: ReactNode;
  buttonProps?: Omit<ButtonProps, "children" | "href" | "onClick" | "target">;
}

export function FinancialApprovalLink({
  approvalUrl,
  children,
  buttonProps,
}: Props) {
  const [open, setOpen] = useState(false);
  const approvalOrigin = useMemo(() => {
    try {
      return new URL(approvalUrl).origin;
    } catch {
      return approvalUrl;
    }
  }, [approvalUrl]);

  function continueToApproval() {
    setOpen(false);
    const approvalWindow = window.open(
      approvalUrl,
      "_blank",
      "noopener,noreferrer",
    );
    if (approvalWindow) approvalWindow.opener = null;
  }

  return (
    <>
      <Button
        type="link"
        {...buttonProps}
        href={approvalUrl}
        target="_blank"
        rel="noopener noreferrer"
        icon={buttonProps?.icon ?? <Icon name="external-link" />}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </Button>
      <Modal
        open={open}
        title="Continue to secure CoCalc confirmation?"
        okText="Continue"
        cancelText="Cancel"
        onOk={continueToApproval}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Typography.Paragraph>
          To protect financial actions from project and notebook content, CoCalc
          confirms this action on a separate secure site. You will sign in again
          before reviewing the final details.
        </Typography.Paragraph>
        <Typography.Paragraph>
          Verify that your browser opens:{" "}
          <Typography.Text code>{approvalOrigin}</Typography.Text>
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
