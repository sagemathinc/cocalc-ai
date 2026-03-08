import { getDefaultForkName } from "../chatroom-modals";

describe("chatroom fork modal defaults", () => {
  it("builds the initial fork title without a follow-up effect", () => {
    expect(getDefaultForkName("Original chat")).toBe("Fork of Original chat");
    expect(getDefaultForkName("  Original chat  ")).toBe(
      "Fork of Original chat",
    );
    expect(getDefaultForkName("")).toBe("Fork of chat");
    expect(getDefaultForkName(undefined)).toBe("Fork of chat");
  });
});
