import { useAppStatus } from "./use-app-status";
import { Button, Space, Spin } from "antd";
import ShowError from "@cocalc/frontend/components/error";
import { useEffect } from "react";
import AppStatus from "./app-status";
import { withProjectHostBase } from "@cocalc/frontend/project/host-url";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export default function AppState({
  name,
  setUrl,
  autoStart,
  onStatus,
  onLoading,
}: {
  name: string;
  setUrl: (url: string | undefined) => void;
  autoStart: boolean;
  onStatus?: (status: any) => void;
  onLoading?: (loading: boolean) => void;
}) {
  const { project_id } = useProjectContext();
  const { status, error, setError, loading, refresh, start, stop } =
    useAppStatus({
      name,
    });

  useEffect(() => {
    if (autoStart && status?.state != "running") {
      start();
    }
  }, [name, autoStart]);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const rawUrl =
        status?.state == "running" && status?.ready === true && status?.url
          ? withProjectHostBase(project_id, status.url)
          : undefined;
      if (!rawUrl) {
        if (!canceled) setUrl(undefined);
        return;
      }
      const authedUrl = await webapp_client.conat_client.addProjectHostAuthToUrl({
        project_id,
        url: rawUrl,
      });
      if (!canceled) {
        setUrl(authedUrl);
      }
    })().catch((_err) => {
      if (!canceled) {
        setUrl(undefined);
      }
    });
    return () => {
      canceled = true;
    };
  }, [project_id, status, setUrl]);

  useEffect(() => {
    onStatus?.(status);
  }, [status, onStatus]);

  useEffect(() => {
    onLoading?.(loading);
  }, [loading, onLoading]);

  if (status == null && !error) {
    return <Spin />;
  }
  return (
    <div>
      <ShowError error={error} setError={setError} />
      <Space.Compact>
        <Button onClick={() => start()}>Start</Button>
        <Button disabled={status?.state != "running"} onClick={() => stop()}>
          Stop
        </Button>
        {loading && <Spin />}
      </Space.Compact>
      <Button onClick={() => refresh()} style={{ float: "right" }}>
        Refresh
      </Button>
      {status != null && <AppStatus status={status} name={name} />}
    </div>
  );
}
