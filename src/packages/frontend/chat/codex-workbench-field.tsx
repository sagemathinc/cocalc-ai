import { Button, Checkbox, Form, Popover } from "antd";
import { useId, useState } from "react";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function CodexWorkbenchField() {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();

  return (
    <KeyboardBoundary
      boundary="workbench-setting"
      style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 14 }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !helpOpen) return;
        event.preventDefault();
        event.stopPropagation();
        setHelpOpen(false);
      }}
    >
      <Form.Item name="workbench" valuePropName="checked" noStyle>
        <Checkbox>Workbench (experimental)</Checkbox>
      </Form.Item>
      <Popover
        trigger="click"
        placement="top"
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title="Workbench (experimental)"
        content={
          <div
            id={helpId}
            style={{ maxWidth: "min(320px, calc(100vw - 64px))" }}
          >
            <p>
              Let Codex publish documents, file/image previews, commits, GitHub
              PRs, and proposed actions as cards. Open them in tabs beside chat
              to review and comment.
            </p>
            <p>
              Off by default. This setting is saved for this thread and its
              collaborators. It applies to future turns in the full chat editor,
              not the Agents page or flyout.
            </p>
            <p style={{ marginBottom: 0 }}>
              Experimental: formats may change. Turning it off stops default
              publication; existing cards and workbench tabs remain available.
              No additional permissions or action approvals are granted.
            </p>
          </div>
        }
      >
        <Button
          type="text"
          size="small"
          aria-label="About Workbench (experimental)"
          aria-expanded={helpOpen}
          aria-controls={helpOpen ? helpId : undefined}
          icon={<Icon name="question-circle" />}
        />
      </Popover>
    </KeyboardBoundary>
  );
}
