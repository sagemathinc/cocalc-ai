/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/* The startup banner

If you want to develop this, edit packages/frontend/app/render.tsx as indicated there so the
startup banner doesn't vanish.
*/

// @ts-ignore -- this is a webpack thing, which confuses typescript.
import cocalc_word from "./cocalc-word.svg";
// @ts-ignore
import cocalc_circle from "./cocalc-circle.svg";
import useCustomize from "./customize";
import "./startup-banner.css";

export function TestBanner() {
  return <StartupBanner />;
}

export default function StartupBanner() {
  const customize = useCustomize();

  return (
    <div className="cocalc-startup-shell">
      <div className="cocalc-startup-card">
        <div className="cocalc-startup-brand">
          <div className="cocalc-startup-mark">
            <div className="cocalc-startup-halo" />
            <div className="cocalc-startup-orbit" />
            {customize.logo_rectangular ? (
              <img
                alt=""
                className="cocalc-startup-custom-logo"
                src={customize.logo_rectangular}
              />
            ) : (
              <img alt="" className="cocalc-startup-logo" src={cocalc_circle} />
            )}
          </div>
          {customize.logo_rectangular ? null : (
            <img alt="" className="cocalc-startup-wordmark" src={cocalc_word} />
          )}
        </div>
        <div className="cocalc-startup-progress" aria-hidden="true">
          <div className="cocalc-startup-progress-bar" />
        </div>
        <div className="cocalc-startup-status" aria-live="polite">
          <span>Connecting...</span>
          <span>Loading workspace...</span>
          <span>Starting CoCalc...</span>
        </div>
      </div>
    </div>
  );
}
