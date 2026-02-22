/*
Project info history hook.
*/

import { useInterval } from "react-interval-hook";
import {
  getHistory,
  type ProjectInfoHistory,
} from "@cocalc/conat/project/project-info";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  const start = useMemo(() => Date.now(), []);
  const [history, setHistory] = useState<ProjectInfoHistory | null>(null);
  const [error, setError] = useState<string>("");
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
    try {
      const value = await getHistory({ project_id, minutes });
      setHistory(value);
      setError("");
    } catch (err) {
      if (Date.now() - start > intervalVisible * 2.1) {
        setError(`Unable to load process history: ${err}`);
      }
    }
  }, [project_id, minutes, start, intervalVisible]);

  useInterval(update, visible ? intervalVisible : intervalHidden);

  useEffect(() => {
    void update();
  }, [project_id, minutes, update]);

  return { history, error, refresh: update };
}
