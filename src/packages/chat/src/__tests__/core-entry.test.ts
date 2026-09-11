test("lightweight chat core loads without workbench artifact modules", () => {
  jest.isolateModules(() => {
    jest.doMock("../artifacts", () => {
      throw Error("Workbench artifacts must not load through chat/core");
    });
    try {
      const core = require("../core");
      expect(core.CHAT_SCHEMA_V2).toBe(2);
      expect(typeof core.buildChatMessage).toBe("function");
      expect(core.validateArtifact).toBeUndefined();
    } finally {
      jest.dontMock("../artifacts");
    }
  });
});
