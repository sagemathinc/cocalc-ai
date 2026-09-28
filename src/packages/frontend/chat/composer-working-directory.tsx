/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useRef, useState } from "react";
import { Button, Input, Modal, Popover, Space, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";
import DirectorySelector from "@cocalc/frontend/project/directory-selector";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import {
  ComposerProjectDirectoryButton,
  displayComposerWorkingDirectory,
} from "./composer-codex-controls";

export function ComposerWorkingDirectory({
  projectId,
  projectTitle,
  directory,
  home,
  onChange,
}: {
  projectId?: string;
  projectTitle: string;
  directory: string;
  home: string;
  onChange: (directory: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [draft, setDraft] = useState(directory);
  const [error, setError] = useState("");
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const apply = (value: string) => {
    try {
      onChange(
        normalizeAbsolutePath(value.trim().replace(/^~(?=\/|$)/, home), home),
      );
      setError("");
      if (choosing) {
        setChoosing(false);
      } else {
        close();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      <Tooltip title={`${projectTitle} / ${directory}`}>
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) {
              setDraft(directory);
              setError("");
            }
          }}
          trigger="click"
          placement="topLeft"
          content={
            <KeyboardBoundary
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
              }}
            >
              <Space
                orientation="vertical"
                size={8}
                role="dialog"
                aria-label="Working directory"
                style={{ width: "min(360px, calc(100vw - 32px))" }}
              >
                <Typography.Text strong>Working directory</Typography.Text>
                <Space.Compact style={{ width: "100%" }}>
                  <Input
                    aria-label="Working directory"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPressEnter={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      apply(draft);
                    }}
                  />
                  <Button type="primary" onClick={() => apply(draft)}>
                    Apply
                  </Button>
                </Space.Compact>
                <Button
                  icon={<Icon name="folder-open" />}
                  disabled={!projectId}
                  onClick={() => {
                    setOpen(false);
                    setChoosing(true);
                  }}
                >
                  Choose directory...
                </Button>
                {error && <div role="alert">{error}</div>}
              </Space>
            </KeyboardBoundary>
          }
        >
          <ComposerProjectDirectoryButton
            ref={trigger}
            projectTitle={projectTitle}
            directory={directory}
            displayedDirectory={displayComposerWorkingDirectory(
              directory,
              home,
            )}
          />
        </Popover>
      </Tooltip>
      <Modal
        open={choosing}
        title="Choose working directory"
        footer={null}
        destroyOnHidden
        focusable={{ focusTriggerAfterClose: false }}
        onCancel={() => setChoosing(false)}
        afterClose={() => trigger.current?.focus()}
        modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
      >
        {projectId && (
          <DirectorySelector
            project_id={projectId}
            startingPath={directory}
            allowAbsolutePaths
            closable={false}
            onSelect={apply}
          />
        )}
        {error && <div role="alert">{error}</div>}
      </Modal>
    </>
  );
}
