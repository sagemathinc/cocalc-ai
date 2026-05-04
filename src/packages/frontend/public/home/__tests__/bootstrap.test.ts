/** @jest-environment jsdom */

jest.mock("react-dom/client", () => ({
  createRoot: jest.fn(),
}));

import { createRoot } from "react-dom/client";

import { init } from "../../bootstrap";

describe("public home bootstrap", () => {
  const render = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (createRoot as jest.Mock).mockReturnValue({ render });
    document.body.innerHTML = '<div id="cocalc-webapp-container"></div>';
  });

  it("mounts the public bootstrap app immediately", async () => {
    await init();

    expect(createRoot).toHaveBeenCalledWith(
      document.getElementById("cocalc-webapp-container"),
    );
    expect(render).toHaveBeenCalledTimes(1);
  });
});
