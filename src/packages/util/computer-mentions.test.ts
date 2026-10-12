import {
  computerMentionsNote,
  extractComputerMentions,
  parseComputerMention,
  serializeComputerMention,
} from "./computer-mentions";

const ID = "1a057860-889d-461a-9073-4b8c69d65123";

describe("computer mentions", () => {
  it("round-trips through its markup", () => {
    const markup = serializeComputerMention({
      version: 1,
      computer_id: ID,
      name: "m1",
    });
    expect(markup).toMatch(/^<span class="computer-mention" /);
    expect(markup.endsWith(">@m1</span>")).toBe(true);
    expect(parseComputerMention(markup)).toEqual({
      version: 1,
      computer_id: ID,
      name: "m1",
    });
  });

  it("refuses markup whose shown name differs, or that isn't ours", () => {
    const markup = serializeComputerMention({
      version: 1,
      computer_id: ID,
      name: "m1",
    });
    expect(parseComputerMention(markup.replace(">@m1<", ">@m2<"))).toBe(
      undefined,
    );
    expect(
      parseComputerMention('<span class="user-mention">@m1</span>'),
    ).toBeUndefined();
    expect(() =>
      serializeComputerMention({
        version: 1,
        computer_id: "nope",
        name: "m1",
      }),
    ).toThrow();
  });

  it("extracts each computer once", () => {
    const m = (name: string, id = ID) =>
      serializeComputerMention({ version: 1, computer_id: id, name });
    const other = "2b057860-889d-461a-9073-4b8c69d65123";
    expect(
      extractComputerMentions(
        `check ${m("m1")} and ${m("m1")} then ${m("box", other)}; plain @m1`,
      ).map((r) => r.name),
    ).toEqual(["m1", "box"]);
  });

  it("tells the agent what it is and how to use it", () => {
    expect(computerMentionsNote([])).toBe("");
    const note = computerMentionsNote([
      { version: 1, name: "m1", computer_id: ID },
    ]);
    expect(note).toMatch(/- @m1 \(computer_id 1a057860-/);
    expect(note).toMatch(/cocalc computer exec @NAME/);
    expect(note).toMatch(/not permission/);
  });
});
