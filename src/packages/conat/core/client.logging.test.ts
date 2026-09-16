/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

describe("Conat client diagnostics", () => {
  it("never logs authentication headers through the cache key", () => {
    const previous = process.env.COCALC_CONAT_LOG_CLIENT_CREATION;
    process.env.COCALC_CONAT_LOG_CLIENT_CREATION = "1";
    const debug = jest.fn();
    jest.resetModules();
    jest.doMock("@cocalc/conat/logger", () => ({
      getLogger: () => ({
        debug,
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        silly: jest.fn(),
      }),
    }));
    try {
      jest.isolateModules(() => {
        const { connect } = require("./client");
        const client = connect({
          address: "http://127.0.0.1:1",
          autoConnect: false,
          extraHeaders: { Cookie: "bay=raw-secret-that-must-not-be-logged" },
        });
        client.close();
      });
      expect(debug).toHaveBeenCalled();
      expect(JSON.stringify(debug.mock.calls)).not.toContain(
        "raw-secret-that-must-not-be-logged",
      );
    } finally {
      if (previous == null) {
        delete process.env.COCALC_CONAT_LOG_CLIENT_CREATION;
      } else {
        process.env.COCALC_CONAT_LOG_CLIENT_CREATION = previous;
      }
      jest.dontMock("@cocalc/conat/logger");
      jest.resetModules();
    }
  });
});
