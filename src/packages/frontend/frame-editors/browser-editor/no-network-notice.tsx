/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A shared browser in a project without network access (free projects) can
// only open pages the project itself serves: say so, and how to get more.

import { Alert, Button } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { networkAccessDisabledFromRunQuota } from "@cocalc/frontend/project/page/network-disabled-badge";
import { useProjectRunQuota } from "@cocalc/frontend/project/use-project-run-quota";
import { joinUrlPath } from "@cocalc/util/url-path";

export function useProjectNetworkDisabled(projectId: string): boolean {
  const { runQuota } = useProjectRunQuota(projectId);
  return networkAccessDisabledFromRunQuota(runQuota);
}

export function NoNetworkNotice({
  onRunOnComputer,
}: {
  // Offered for a .browser file: on the user's computer it uses their
  // network.
  onRunOnComputer?: () => void;
}) {
  return (
    <Alert
      type="warning"
      showIcon
      banner
      title={
        <>
          This project has no internet access, so this browser can only open
          pages served by the project itself (e.g. <code>localhost:8000</code>
          ).{" "}
          <a href={joinUrlPath(appBasePath, "settings", "membership")}>
            Upgrade your membership
          </a>{" "}
          to browse the web
          {onRunOnComputer ? ", or run this browser on your computer" : ""}.
        </>
      }
      action={
        onRunOnComputer ? (
          <Button size="small" onClick={onRunOnComputer}>
            Run on my computer
          </Button>
        ) : undefined
      }
    />
  );
}
