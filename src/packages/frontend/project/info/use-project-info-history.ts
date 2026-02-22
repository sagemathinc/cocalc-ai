/*
Project info history hook.
*/

import { useInterval } from "react-interval-hook";
import {
  getHistory,
  type ProjectInfoHistory,
} from "@cocalc/conat/project/project-info";
import { useEffect, useMemo, useState } from "react";

export default function useProjectInfoHistory({
  project_id,
  interval = 30000,
  minutes = 60,
}: {
  project_id: string;
  interval?: number;
  minutes?: number;
}): {
  history: ProjectInfoHistory | null;
  error: string;
} {
  const start = useMemo(() => Date.now(), []);
  const [history, setHistory] = useState<ProjectInfoHistory | null>(null);
  const [error, setError] = useState<string>("");

  const update = async () => {
    try {
      const value = await getHistory({ project_id, minutes });
      setHistory(value);
      setError("");
    } catch (err) {
      if (Date.now() - start > interval * 2.1) {
        setError(`Unable to load process history: ${err}`);
      }
    }
  };

  useInterval(update, interval);

  useEffect(() => {
    update();
  }, [project_id, minutes]);

  return { history, error };
}

