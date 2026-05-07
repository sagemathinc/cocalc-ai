/*
Project info history hook.
*/

import { useInterval } from "react-interval-hook";
import {
  getHistory,
  type ProjectInfoHistory,
} from "@cocalc/conat/project/project-info";
import { useCallback, useEffect, useRef, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";

function isVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible";
}

export default function useProjectInfoHistory({
  project_id,
  intervalVisible = 10000,
  intervalHidden = 60000,
  minutes = 60,
}: {
  project_id: string;
  intervalVisible?: number;
  intervalHidden?: number;
  minutes?: number;
}): {
  history: ProjectInfoHistory | null;
  error: string;
  refresh: () => Promise<void>;
} {
  const startRef = useRef(Date.now());
  const scopeRef = useRef(`${project_id}:${minutes}`);
  scopeRef.current = `${project_id}:${minutes}`;
  const [history, setHistory] = useState<ProjectInfoHistory | null>(null);
  const [error, setError] = useState<string>("");
  const [visible, setVisible] = useState<boolean>(isVisible());

  const update = useCallback(async () => {
    const requestScope = `${project_id}:${minutes}`;
    try {
      const client = await webapp_client.conat_client.projectConat({
        project_id,
        caller: "useProjectInfoHistory",
      });
      const value = await getHistory({
        client,
        project_id,
        minutes,
      });
      if (scopeRef.current !== requestScope) return;
      setHistory(value);
      setError("");
    } catch (err) {
      if (scopeRef.current !== requestScope) return;
      if (Date.now() - startRef.current > intervalVisible * 2.1) {
        setError(`Unable to load process history: ${err}`);
      }
    }
  }, [project_id, minutes, intervalVisible]);

  useEffect(() => {
    startRef.current = Date.now();
    setHistory(null);
    setError("");
  }, [project_id, minutes]);

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
  }, [project_id, minutes, update]);

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

  return { history, error, refresh: update };
}
