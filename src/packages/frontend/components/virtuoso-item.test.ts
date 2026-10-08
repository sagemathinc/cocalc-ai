import { virtuosoItemContent, virtuosoItemKey } from "./virtuoso-item";

describe("virtuoso item callbacks", () => {
  type Row = { id: string };
  const key = jest.fn((_index: number, row: Row) => row.id);
  const content = jest.fn((_index: number, row: Row) => `content ${row.id}`);

  beforeEach(() => {
    key.mockClear();
    content.mockClear();
  });

  it("passes defined items through", () => {
    expect(virtuosoItemKey(key)(0, { id: "a" })).toBe("a");
    expect(virtuosoItemContent(content)(0, { id: "a" })).toBe("content a");
  });

  it("keys a missing item by index and renders nothing", () => {
    expect(virtuosoItemKey(key)(7, undefined)).toBe("index-7");
    expect(virtuosoItemContent(content)(7, undefined)).toBeNull();
    expect(key).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
  });
});
