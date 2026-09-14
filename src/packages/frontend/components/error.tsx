import { SyncOutlined } from "@ant-design/icons";
import { Alert, Button, Popconfirm } from "antd";
import { CSSProperties, useState } from "react";
import StaticMarkdown from "./lazy-static-markdown";
import { useProjectErrorActions } from "./project-error-actions";

export const PROJECT_RUNTIME_UPGRADE_ERROR_SIGNATURE =
  "For a project/server runtime, restart or update the runtime and retry.";

interface Props {
  error: any;
  setError?: (error: any) => void;
  style?: CSSProperties;
  message?;
  banner?;
  noMarkdown?: boolean;
}
export default function ShowError({
  message = "Error",
  error,
  setError,
  style,
  banner,
  noMarkdown,
}: Props) {
  const projectErrorActions = useProjectErrorActions();
  if (!error) return null;
  const err = normalizeUserFacingError(
    `${error}`.replace(/Error:/g, "").trim(),
  );
  const showRestart =
    projectErrorActions != null &&
    err.includes(PROJECT_RUNTIME_UPGRADE_ERROR_SIGNATURE);
  return (
    <Alert
      banner={banner}
      style={style}
      showIcon
      title={message}
      type="error"
      description={
        <div>
          <div
            style={{ maxHeight: "150px", overflow: "auto", textWrap: "wrap" }}
          >
            {noMarkdown ? err : <StaticMarkdown value={err} />}
          </div>
          {showRestart && (
            <RestartProjectAfterUpgrade
              restartProject={projectErrorActions.restartProject}
              clearError={() => setError?.("")}
            />
          )}
        </div>
      }
      onClose={() => setError?.("")}
      closable={setError != null}
    />
  );
}

function RestartProjectAfterUpgrade({
  restartProject,
  clearError,
}: {
  restartProject: () => Promise<void> | void;
  clearError: () => void;
}) {
  const [restarting, setRestarting] = useState(false);

  return (
    <div style={{ marginTop: "12px" }}>
      <Popconfirm
        title="Restart project?"
        description="This restarts the project server so it uses the latest CoCalc project code."
        okText="Restart"
        cancelText="Not now"
        onConfirm={async () => {
          setRestarting(true);
          try {
            await restartProject();
            clearError();
          } finally {
            setRestarting(false);
          }
        }}
      >
        <Button
          type="primary"
          size="large"
          icon={<SyncOutlined />}
          loading={restarting}
          aria-label="Restart Project"
        >
          Restart Project
        </Button>
      </Popconfirm>
    </div>
  );
}

function normalizeUserFacingError(error: string): string {
  const normalized = error.trim();
  if (
    normalized.includes("openat2 is required in safe mode") &&
    normalized.includes("native addon initialization failed")
  ) {
    return "Project filesystem is not available right now. If this project is archived, start it to restore it from backup. If it is stopped, start it to make the filesystem available again.";
  }
  return normalized;
}
