import { Tag } from "antd";
import { Tooltip } from "@cocalc/frontend/components/tip";

export interface WorktreeNotice {
  message: string;
  locating: boolean;
}

export function WorktreeStatus({ notice }: { notice?: WorktreeNotice }) {
  return (
    <span
      role="status"
      aria-label="Worktree status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        flex: "0 0 126px",
        width: 126,
        height: 24,
        marginInlineStart: "auto",
      }}
    >
      <Tooltip title={notice?.message} trigger={["hover", "focus"]}>
        <span
          tabIndex={notice ? 0 : -1}
          style={{ visibility: notice ? "visible" : "hidden", width: "100%" }}
        >
          <Tag style={{ margin: 0, width: "100%", textAlign: "center" }}>
            {notice && !notice.locating
              ? "Historical view"
              : "Locating worktree"}
          </Tag>
        </span>
      </Tooltip>
    </span>
  );
}
