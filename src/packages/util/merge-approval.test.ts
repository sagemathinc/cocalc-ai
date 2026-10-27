import {
  mergeApprovalNeedsSecondFactor,
  normalizeMergeApprovalChatRef,
  normalizeMergeApprovalHeadSha,
  normalizeMergeApprovalPrNumber,
  normalizeMergeApprovalRepo,
  normalizeMergeApprovalText,
  parseMergeApprovalInstallations,
  parseMergeApprovalRepos,
  parseMergeApprovers,
} from "./merge-approval";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";

describe("merge approval normalizers", () => {
  it("accepts owner/name repos, lowercased", () => {
    expect(normalizeMergeApprovalRepo(" SageMathInc/CoCalc-AI ")).toBe(
      "sagemathinc/cocalc-ai",
    );
    for (const bad of ["", "cocalc", "a/b/c", "-x/y", "x/..", "x/.", "x/y z"]) {
      expect(() => normalizeMergeApprovalRepo(bad)).toThrow("owner/name");
    }
  });

  it("accepts positive integer PR numbers", () => {
    expect(normalizeMergeApprovalPrNumber(1426)).toBe(1426);
    expect(normalizeMergeApprovalPrNumber("12")).toBe(12);
    for (const bad of [0, -1, 1.5, "x", null, 1e10]) {
      expect(() => normalizeMergeApprovalPrNumber(bad)).toThrow("pr_number");
    }
  });

  it("requires the full 40-character head SHA", () => {
    const sha = "a".repeat(40);
    expect(normalizeMergeApprovalHeadSha(sha.toUpperCase())).toBe(sha);
    for (const bad of ["a".repeat(39), "a".repeat(41), "g".repeat(40), ""]) {
      expect(() => normalizeMergeApprovalHeadSha(bad)).toThrow("full");
    }
  });

  it("limits text by UTF-8 bytes", () => {
    expect(normalizeMergeApprovalText(undefined, 10, "note")).toBe("");
    expect(normalizeMergeApprovalText("abcd", 4, "note")).toBe("abcd");
    // 3 characters, 6 bytes
    expect(() => normalizeMergeApprovalText("ééé", 5, "note")).toThrow(
      "note is longer than 5 bytes",
    );
  });

  it("keeps chat references in the requesting project", () => {
    expect(normalizeMergeApprovalChatRef(undefined, PROJECT)).toBeUndefined();
    expect(
      normalizeMergeApprovalChatRef(
        { path: "a.chat", thread_id: "t", message_date: "d" },
        PROJECT,
      ),
    ).toEqual({
      project_id: PROJECT,
      path: "a.chat",
      thread_id: "t",
      message_date: "d",
    });
    expect(() =>
      normalizeMergeApprovalChatRef(
        { path: "a.chat", project_id: OTHER_PROJECT },
        PROJECT,
      ),
    ).toThrow("requesting project");
    expect(() => normalizeMergeApprovalChatRef({ path: "" }, PROJECT)).toThrow(
      "chat path",
    );
  });
});

describe("merge approval settings", () => {
  it("parses approvers, ignoring anything that is not an account id", () => {
    expect(
      parseMergeApprovers(`${PROJECT}, x ${PROJECT}\n${OTHER_PROJECT}`),
    ).toEqual([PROJECT, OTHER_PROJECT]);
    expect(parseMergeApprovers("")).toEqual([]);
  });

  it("parses repos and installations", () => {
    expect(parseMergeApprovalRepos("A/b, bad c/d A/B")).toEqual(["a/b", "c/d"]);
    expect([
      ...parseMergeApprovalInstallations("SageMathInc:123 x:y other:9"),
    ]).toEqual([
      ["sagemathinc", "123"],
      ["other", "9"],
    ]);
  });

  it("requires a second factor everywhere unless the setting says otherwise", () => {
    expect(mergeApprovalNeedsSecondFactor("a/b", "*")).toBe(true);
    // blank fails closed
    expect(mergeApprovalNeedsSecondFactor("a/b", "")).toBe(true);
    expect(mergeApprovalNeedsSecondFactor("a/b", undefined)).toBe(true);
    expect(mergeApprovalNeedsSecondFactor("a/b", "none")).toBe(false);
    expect(mergeApprovalNeedsSecondFactor("a/b", "A/B, c/d")).toBe(true);
    expect(mergeApprovalNeedsSecondFactor("e/f", "a/b c/d")).toBe(false);
  });
});
