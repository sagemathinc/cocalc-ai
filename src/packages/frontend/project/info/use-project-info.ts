/*
React hook that gives realtime information about a project.

*/

import { useInterval } from "react-interval-hook";
import { get, type ProjectInfo } from "@cocalc/conat/project/project-info";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { labels } from "@cocalc/frontend/i18n";

function isVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

export default function useProjectInfo({
  project_id,
  intervalVisible = 10000,
  intervalHidden = 60000,
}: {
  project_id: string;
  intervalVisible?: number;
  intervalHidden?: number;
}): {
  info: ProjectInfo | null;
  error: string;
  setError: (string) => void;
  disconnected: boolean;
  refresh: () => Promise<void>;
} {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const projectLabelLower = projectLabel.toLowerCase();
  const start = useMemo(() => Date.now(), []);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string>("");
  const [disconnected, setDisconnected] = useState<boolean>(true);
  const [visible, setVisible] = useState<boolean>(isVisible());

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => setVisible(isVisible());
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const update = useCallback(async () => {
    // console.log("update", { project_id });
    try {
      const info = await get({ project_id });
      setInfo(info);
      setDisconnected(false);
      setError("");
    } catch (err) {
      if (Date.now() - start >= intervalVisible * 2.1) {
        console.log(`WARNING: project info -- ${err}`);
        setError(
          `${projectLabel} info not available -- start the ${projectLabelLower}`,
        );
      }
      setDisconnected(true);
    }
  }, [project_id, start, intervalVisible, projectLabel, projectLabelLower]);

  useInterval(update, visible ? intervalVisible : intervalHidden);

  useEffect(() => {
    void update();
  }, [project_id, update]);

  return { info, error, setError, disconnected, refresh: update };
}
