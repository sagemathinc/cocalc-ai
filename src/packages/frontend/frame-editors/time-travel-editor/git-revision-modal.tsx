/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Modal, Spin } from "antd";
import { Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";
import type { GitHistoricalFileRequest } from "@cocalc/frontend/git/historical-file";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

const Content = lazy(() => import("./git-revision-content"));
class RevisionBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Alert type="error" title="Unable to display this historical file" />
    ) : (
      this.props.children
    );
  }
}

export function GitRevisionModal({
  request,
  onClose,
  fontSize = 14,
}: {
  request?: GitHistoricalFileRequest;
  onClose: () => void;
  fontSize?: number;
}) {
  return (
    <Modal
      title="TimeTravel: Git revision"
      open={request != null}
      onCancel={onClose}
      footer={null}
      width="90vw"
      destroyOnHidden
    >
      {request && (
        <KeyboardBoundary
          boundary="git-revision"
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
          }}
        >
          <RevisionBoundary key={JSON.stringify(request)}>
            <Suspense
              fallback={<Spin aria-label="Loading historical viewer" />}
            >
              <Content request={request} fontSize={fontSize} />
            </Suspense>
          </RevisionBoundary>
        </KeyboardBoundary>
      )}
    </Modal>
  );
}
