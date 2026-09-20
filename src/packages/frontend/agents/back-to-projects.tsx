import { useRef, useState } from "react";
import { ArrowLeftOutlined, CloseOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const DISMISSED_KEY = "agents.back-to-projects-note-dismissed";

export function BackToProjects({ onBack }: { onBack: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [showNote, setShowNote] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) !== "true";
    } catch {
      return true;
    }
  });

  function dismiss() {
    setShowNote(false);
    try {
      localStorage.setItem(DISMISSED_KEY, "true");
    } catch {
      // Navigation remains usable when browser storage is unavailable.
    }
    buttonRef.current?.focus();
  }

  return (
    <nav
      aria-label="Return to Projects"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        flexShrink: 0,
        background: UI_COLORS.page,
        color: UI_COLORS.text,
      }}
    >
      <Tooltip title="Return to your projects, courses, and files.">
        <Button
          ref={buttonRef}
          icon={<ArrowLeftOutlined aria-hidden />}
          onClick={onBack}
        >
          Back to Projects
        </Button>
      </Tooltip>
      {showNote && (
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <span>
            Your projects and courses are still here. Use Back to Projects at
            any time.
          </span>
          <Button
            type="text"
            icon={<CloseOutlined />}
            aria-label="Dismiss Projects navigation tip"
            onClick={dismiss}
            style={{ flexShrink: 0 }}
          />
        </div>
      )}
    </nav>
  );
}
