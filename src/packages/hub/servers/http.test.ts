import express from "express";

import init from "./http";

describe("hub HTTP server", () => {
  it("treats server error events as fatal", () => {
    const server = init({ app: express() });
    const err = new Error("EADDRINUSE");
    const setImmediateMock = jest
      .spyOn(global, "setImmediate")
      .mockImplementation(((fn: (...args: any[]) => void) => {
        fn();
        return {} as NodeJS.Immediate;
      }) as typeof setImmediate);

    try {
      expect(() => server.emit("error", err)).toThrow(err);
      expect(setImmediateMock).toHaveBeenCalledTimes(1);
    } finally {
      setImmediateMock.mockRestore();
    }
  });
});
