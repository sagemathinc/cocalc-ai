/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { act, render } from "@testing-library/react";
import useProjectInfo from "./use-project-info";

jest.mock("react-interval-hook", () => ({
  useInterval: jest.fn(),
}));

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: () => "Project",
  }),
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: "project",
  },
}));

const projectConat = jest.fn();
const getProjectInfo = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => {
  const { EventEmitter } = require("events");
  const conat_client = Object.assign(new EventEmitter(), {
    removeListener: EventEmitter.prototype.removeListener,
    projectConat: (...args) => projectConat(...args),
  });
  return {
    webapp_client: {
      conat_client,
    },
  };
});

jest.mock("@cocalc/conat/project/project-info", () => ({
  get: (...args) => getProjectInfo(...args),
}));

function TestComponent() {
  useProjectInfo({ project_id: "project-1" });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useProjectInfo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    projectConat.mockResolvedValue({ client: "project" });
    getProjectInfo.mockResolvedValue({
      timestamp: Date.now(),
      processes: {},
      cgroup: null,
      disk_usage: null,
    });
  });

  it("refreshes when the conat client reconnects", async () => {
    const { webapp_client } = jest.requireMock(
      "@cocalc/frontend/webapp-client",
    ) as {
      webapp_client: {
        conat_client: EventEmitter & {
          projectConat: jest.Mock;
          removeListener: typeof EventEmitter.prototype.removeListener;
        };
      };
    };

    render(<TestComponent />);
    await flush();
    expect(projectConat).toHaveBeenCalledTimes(1);

    act(() => {
      webapp_client.conat_client.emit("connected");
    });
    await flush();

    expect(projectConat).toHaveBeenCalledTimes(2);
    expect(getProjectInfo).toHaveBeenCalledTimes(2);
  });

  it("refreshes when a hidden tab becomes visible", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    render(<TestComponent />);
    await flush();
    expect(projectConat).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    expect(projectConat).toHaveBeenCalledTimes(2);
    expect(getProjectInfo).toHaveBeenCalledTimes(2);
  });
});
