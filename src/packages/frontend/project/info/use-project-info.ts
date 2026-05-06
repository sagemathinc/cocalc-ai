/*
React hook that gives realtime information about a project.

*/

import { useInterval } from "react-interval-hook";
import { get, type ProjectInfo } from "@cocalc/conat/project/project-info";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";

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
  const startRef = useRef(Date.now());
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string>("");
  const [disconnected, setDisconnected] = useState<boolean>(true);
  const [visible, setVisible] = useState<boolean>(isVisible());

  const update = useCallback(async () => {
    // console.log("update", { project_id });
    try {
      const client = await webapp_client.conat_client.projectConat({
        project_id,
        caller: "useProjectInfo",
      });
      const info = await get({
        client,
        project_id,
      });
      setInfo(info);
      setDisconnected(false);
      setError("");
    } catch (err) {
      if (Date.now() - startRef.current >= intervalVisible * 2.1) {
        console.log(`WARNING: project info -- ${err}`);
        setError(
          `${projectLabel} info not available -- start the ${projectLabelLower}`,
        );
      }
      setDisconnected(true);
    }
  }, [project_id, intervalVisible, projectLabel, projectLabelLower]);

  useEffect(() => {
    startRef.current = Date.now();
    setInfo(null);
    setError("");
    setDisconnected(true);
  }, [project_id]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      const nextVisible = isVisible();
      setVisible(nextVisible);
      if (nextVisible) {
        void update();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [update]);

  useInterval(update, visible ? intervalVisible : intervalHidden);

  useEffect(() => {
    void update();
  }, [project_id, update]);

  useEffect(() => {
    if (!visible) return;
    const onConnected = () => {
      void update();
    };
    webapp_client.conat_client.on?.("connected", onConnected);
    return () => {
      webapp_client.conat_client.removeListener?.("connected", onConnected);
    };
  }, [update, visible]);

  return { info, error, setError, disconnected, refresh: update };
}
