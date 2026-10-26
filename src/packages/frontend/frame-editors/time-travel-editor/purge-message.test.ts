import { purgeHistoryMessage } from "./purge-message";

describe("purgeHistoryMessage", () => {
  it("states an exact count as it is", () => {
    expect(purgeHistoryMessage({ deleted: 3 })).toBe(
      "Purged 3 history entries.",
    );
  });

  it("states a history still being counted as a lower bound", () => {
    expect(purgeHistoryMessage({ deleted: 10_000, deletedExact: false })).toBe(
      "Purged more than 10,000 history entries.",
    );
  });
});
