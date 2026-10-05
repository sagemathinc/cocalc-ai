/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A browser older than the required version is disconnected, so it needs more
// than the update indicator: say plainly that nothing works until a reload.
// Recommended updates are only the indicator (BrowserUpdateIndicator).

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Gap } from "@cocalc/frontend/components";
import { type CSSProperties, useEffect } from "react";
import { version } from "@cocalc/util/smc-version";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { hardRefresh } from "./update-indicator";

const STYLE = {
  fontSize: "12pt",
  position: "fixed",
  left: 12,
  top: 20,
  zIndex: 900,
  width: "70%",
  marginTop: "1em",
  borderRadius: 4,
  padding: "15px",
  backgroundColor: "red",
  color: "#fff",
  boxShadow: "8px 8px 4px #888",
} as CSSProperties;

export default function VersionWarning() {
  const minVersion = useTypedRedux("customize", "version_min_browser");

  useEffect(() => {
    if (minVersion > version) {
      // immediately and permenantly disconnect user from conat
      webapp_client.conat_client.permanentlyDisconnect();
    }
  }, [minVersion]);

  if (!(version < minVersion)) return null;
  return (
    <div style={STYLE} role="alert">
      THIS IS A CRITICAL UPDATE. YOU MUST <Gap />
      <a
        onClick={() => void hardRefresh()}
        style={{
          cursor: "pointer",
          color: "white",
          fontWeight: "bold",
          textDecoration: "underline",
        }}
      >
        REFRESH THIS PAGE
      </a>
      <Gap /> IMMEDIATELY. Sorry for the inconvenience.
    </div>
  );
}
