import { Actions } from "./actions";
import { count_words } from "./count_words";

jest.mock("./count_words", () => ({
  count_words: jest.fn(),
}));

describe("LaTeX word count action", () => {
  it("does not show a document error toast when word count fails", async () => {
    jest.mocked(count_words).mockRejectedValue(new Error("texcount failed"));

    const actions: any = Object.create(Actions.prototype);
    actions.project_id = "project-1";
    actions.path = "/home/user/paper.tex";
    actions.make_timestamp = jest.fn(() => 123);
    actions.setState = jest.fn();
    actions.set_error = jest.fn();

    await actions._word_count(123, false, true);

    expect(actions.set_error).not.toHaveBeenCalled();
    expect(actions.setState).toHaveBeenCalledWith({
      word_count: "Error running word count:\ntexcount failed",
    });
  });
});
