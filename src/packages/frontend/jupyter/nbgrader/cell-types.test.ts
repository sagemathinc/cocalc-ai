import { value_to_template_content } from "./cell-types";

describe("nbgrader cell templates", () => {
  it("uses modern dependency-free Python tests", () => {
    const template = value_to_template_content("test", "python", "code");

    expect(template).toContain("assert squares(1) == [1]");
    expect(template).toContain("except ValueError:");
    expect(template).not.toContain("nose.tools");
    expect(template).not.toContain("assert_equal");
    expect(template).not.toContain("assert_raises");
  });
});
