/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// How to install the CoCalc CLI on your own computer: one copyable command,
// and the download page for other platforms.  Used wherever a feature needs
// the CLI locally (SSH, app tunnels, a .browser file running on your
// computer), so the instructions stay the same everywhere.

import { Typography } from "antd";
import type { CSSProperties } from "react";
import {
  COCALC_CLI_DOWNLOAD_URL,
  cocalcCliInstallCommand,
} from "@cocalc/util/consts/ui";
import { A, CopyToClipBoard } from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

const { Text } = Typography;

/** The install command for this site, which serves the CLI at /cli/install.sh. */
export function siteCliInstallCommand(): string {
  const origin =
    typeof window === "undefined" ? "<hub-url>" : window.location.origin;
  return cocalcCliInstallCommand(`${origin}${appBasePath.replace(/\/+$/, "")}`);
}

export function InstallCocalcCli({
  title = "Install CoCalc CLI",
  style,
}: {
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <div style={style}>
      <Text strong>{title}</Text>
      <CopyToClipBoard
        value={siteCliInstallCommand()}
        inputWidth="100%"
        inputStyle={{ minWidth: 0 }}
        outerStyle={{ width: "100%" }}
        style={{ marginTop: 6, width: "100%" }}
      />
      <div style={{ marginTop: 4, fontSize: 12 }}>
        <A href={COCALC_CLI_DOWNLOAD_URL}>
          Other platforms and installation options
        </A>
      </div>
    </div>
  );
}
