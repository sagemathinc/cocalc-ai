/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Modal, Spin } from "antd";
import { Component, lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { DiffPreviewSource } from "./preview-types";

const PierrePreview = lazy(() => import("./pierre-preview"));

class PreviewErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Alert
        type="error"
        title="The experimental diff preview could not load."
      />
    ) : (
      this.props.children
    );
  }
}

export function DiffPreviewButton({
  getSource,
  fontSize = 14,
}: {
  getSource: () => DiffPreviewSource;
  fontSize?: number;
}) {
  // Freeze the source on opening: live history updates must not move a draft.
  const [source, setSource] = useState<DiffPreviewSource>();
  return (
    <>
      <Button size="small" onClick={() => setSource(getSource())}>
        Preview with Pierre
      </Button>
      <Modal
        title="Experimental diff preview"
        open={source != null}
        onCancel={() => setSource(undefined)}
        footer={null}
        width="95vw"
        destroyOnHidden
      >
        {source != null && (
          <KeyboardBoundary boundary="diff-preview">
            <PreviewErrorBoundary>
              <Suspense fallback={<Spin aria-label="Loading diff preview" />}>
                <PierrePreview source={source} fontSize={fontSize} />
              </Suspense>
            </PreviewErrorBoundary>
          </KeyboardBoundary>
        )}
      </Modal>
    </>
  );
}
