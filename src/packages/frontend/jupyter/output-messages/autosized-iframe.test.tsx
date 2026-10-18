/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import AutosizedIframe, {
  type IframeProfile,
  iframeSandbox,
} from "./autosized-iframe";
import { IframeHtml } from "./mime-types/iframe-html";

const PROFILES: IframeProfile[] = [
  "passive",
  "opaque-scripts",
  "opaque-legacy",
  "trusted-same-origin",
];

function frame(profile: IframeProfile) {
  const { container } = render(
    <AutosizedIframe srcDoc="<p>x</p>" profile={profile} title="t" />,
  );
  return container.querySelector("iframe")!;
}

describe("AutosizedIframe profiles", () => {
  it("maps each profile to its sandbox", () => {
    expect(frame("passive").getAttribute("sandbox")).toBe("");
    expect(frame("opaque-scripts").getAttribute("sandbox")).toBe(
      "allow-scripts",
    );
    expect(frame("opaque-legacy").getAttribute("sandbox")).toBe(
      "allow-forms allow-scripts allow-presentation",
    );
    expect(frame("trusted-same-origin").hasAttribute("sandbox")).toBe(false);
  });

  it("never combines scripts with same-origin", () => {
    for (const profile of PROFILES) {
      expect(iframeSandbox(profile) ?? "").not.toContain("allow-same-origin");
    }
  });

  it("sends no referrer from untrusted frames", () => {
    expect(frame("opaque-scripts").getAttribute("referrerpolicy")).toBe(
      "no-referrer",
    );
    expect(frame("trusted-same-origin").hasAttribute("referrerpolicy")).toBe(
      false,
    );
  });

  it("caps and rate limits resize requests, keeping the latest", () => {
    jest.useFakeTimers();
    try {
      const iframe = frame("opaque-scripts");
      const id = /var id = "([^"]+)"/.exec(iframe.getAttribute("srcdoc")!)![1];
      const post = (height: number) =>
        act(() => {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: { type: "cocalc-jupyter-iframe-height", id, height },
              source: iframe.contentWindow,
            }),
          );
        });
      jest.advanceTimersByTime(1000);
      post(1e9);
      expect(iframe.style.height).toBe("25000px");
      // Too soon after the last one: deferred to the end of the interval,
      // and only the latest applies.
      post(100);
      post(200);
      expect(iframe.style.height).toBe("25000px");
      act(() => {
        jest.advanceTimersByTime(49);
      });
      expect(iframe.style.height).toBe("25000px");
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(iframe.style.height).toBe("208px");
      jest.advanceTimersByTime(100);
      post(100);
      expect(iframe.style.height).toBe("108px");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("callers", () => {
  it("untrusted Jupyter HTML output uses the legacy opaque profile", () => {
    const { container } = render(<IframeHtml value="<p>x</p>" />);
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-forms allow-scripts allow-presentation",
    );
  });
});
