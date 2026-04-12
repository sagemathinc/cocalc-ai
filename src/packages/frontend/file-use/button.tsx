/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal } from "antd";

import { React, useState } from "../app-framework";
import { Icon } from "../components";
import { RecentDocumentActivityPanel } from "./panel";

interface Props {
  style?: React.CSSProperties;
}

export function RecentDocumentActivityButton({ style }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button style={style} onClick={() => setOpen(true)}>
        <Icon name="history" /> Recent Activity
      </Button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnHidden
        width={960}
        styles={{
          body: {
            padding: "12px",
            height: "70vh",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          },
        }}
      >
        <RecentDocumentActivityPanel onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
