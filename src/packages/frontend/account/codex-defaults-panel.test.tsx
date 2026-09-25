import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS, Map } from "immutable";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
} from "@cocalc/util/ai/codex";
import { set_account_table } from "@cocalc/frontend/account/util";
import {
  OTHER_SETTINGS_CODEX_NEW_CHAT_DEFAULTS as KEY,
  normalizeCodexNewChatDefaults,
} from "@cocalc/frontend/chat/codex-defaults";
import { CodexDefaultsPanel } from "./codex-defaults-panel";

jest.mock("@cocalc/frontend/account/util", () => ({
  set_account_table: jest.fn(),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => undefined },
}));
jest.mock("@cocalc/frontend/chat/codex-full-access", () => ({
  CodexFullAccessNotice: () => null,
}));

const save = () => screen.getByRole("button", { name: "Save defaults" });
const model = () =>
  screen.getByRole("combobox", { name: "Default Codex model" });
const alternateModel = "gpt-5.6-luna";
const alternateDefaults = normalizeCodexNewChatDefaults({
  ...normalizeCodexNewChatDefaults({}),
  model: alternateModel,
});

async function chooseModel() {
  // Exercise the real Ant Design Select by keyboard, including retained focus.
  const user = userEvent.setup();
  await user.tab();
  expect(model()).toHaveFocus();
  fireEvent.keyDown(model(), { key: "Enter", keyCode: 13 });
  await waitFor(() => expect(model()).toHaveAttribute("aria-expanded", "true"));
  const steps =
    DEFAULT_CODEX_MODELS.findIndex(({ name }) => name === alternateModel) -
    DEFAULT_CODEX_MODELS.findIndex(
      ({ name }) => name === DEFAULT_CODEX_MODEL_NAME,
    );
  for (let i = 0; i < Math.abs(steps); i++) {
    fireEvent.keyDown(model(), {
      key: steps > 0 ? "ArrowDown" : "ArrowUp",
      keyCode: steps > 0 ? 40 : 38,
    });
  }
  fireEvent.keyDown(model(), { key: "Enter", keyCode: 13 });
  await waitFor(() => expect(save()).toBeEnabled());
  expect(model()).toHaveFocus();
}

beforeEach(() => {
  jest.clearAllMocks();
  // Turn a render loop into a bounded failure rather than hanging the suite.
  const originalError = console.error;
  jest.spyOn(console, "error").mockImplementation((message, ...args) => {
    if (String(message).includes("Maximum update depth")) {
      throw new Error("Codex defaults entered a render loop");
    }
    originalError(message, ...args);
  });
});

afterEach(() => jest.restoreAllMocks());

it.each([undefined, Map(), Map({ [KEY]: null })])(
  "keeps the first model selection until saved (settings: %p)",
  async (settings) => {
    render(<CodexDefaultsPanel other_settings={settings} />);
    expect(save()).toBeDisabled();
    await chooseModel();
    expect(set_account_table).not.toHaveBeenCalled();
    fireEvent.click(save());
    expect(set_account_table).toHaveBeenCalledWith({
      other_settings: {
        [KEY]: alternateDefaults,
      },
    });
  },
);

it("preserves an unsaved choice through unrelated and equal settings updates", async () => {
  const settings = Map({ [KEY]: fromJS(normalizeCodexNewChatDefaults({})) });
  const { rerender } = render(<CodexDefaultsPanel other_settings={settings} />);
  await chooseModel();
  rerender(
    <CodexDefaultsPanel other_settings={settings.set("unrelated", true)} />,
  );
  rerender(
    <CodexDefaultsPanel
      other_settings={Map({ [KEY]: fromJS(normalizeCodexNewChatDefaults({})) })}
    />,
  );
  expect(save()).toBeEnabled();
  fireEvent.click(save());
  expect(set_account_table).toHaveBeenLastCalledWith({
    other_settings: {
      [KEY]: alternateDefaults,
    },
  });
});

it("loads saved choices on remount and resets to built-in defaults", async () => {
  const settings = Map({ [KEY]: fromJS(normalizeCodexNewChatDefaults({})) });
  const first = render(<CodexDefaultsPanel other_settings={settings} />);
  await chooseModel();
  fireEvent.click(save());
  const savedSettings = fromJS(
    jest.mocked(set_account_table).mock.calls[0][0].other_settings,
  );
  first.unmount();
  const { rerender } = render(
    <CodexDefaultsPanel other_settings={savedSettings} />,
  );
  expect(save()).toBeDisabled();
  expect(screen.getByText(alternateModel)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Reset to built-in defaults" }),
  );
  const resetSettings = fromJS(
    jest.mocked(set_account_table).mock.calls[1][0].other_settings,
  );
  expect(resetSettings.getIn([KEY, "model"])).toBe(DEFAULT_CODEX_MODEL_NAME);
  rerender(<CodexDefaultsPanel other_settings={resetSettings} />);
  expect(save()).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reset to built-in defaults" }),
  ).toBeDisabled();
});

it("resynchronizes when saved defaults actually change or are removed", async () => {
  const settings = Map({ [KEY]: fromJS(normalizeCodexNewChatDefaults({})) });
  const { rerender, container } = render(
    <CodexDefaultsPanel other_settings={settings} />,
  );
  await chooseModel();
  rerender(
    <CodexDefaultsPanel
      other_settings={Map({
        [KEY]: fromJS({ model: "gpt-6-sol", reasoning: "high" }),
      })}
    />,
  );
  expect(within(container).getByTitle("gpt-6-sol")).toBeVisible();
  expect(within(container).getByTitle("High")).toBeVisible();
  rerender(
    <CodexDefaultsPanel
      other_settings={Map({
        [KEY]: fromJS({ model: "gpt-6-sol", reasoning: "low" }),
      })}
    />,
  );
  expect(within(container).getByTitle("Low")).toBeVisible();
  expect(save()).toBeDisabled();
  rerender(<CodexDefaultsPanel other_settings={Map()} />);
  expect(within(container).getByTitle(DEFAULT_CODEX_MODEL_NAME)).toBeVisible();
  expect(save()).toBeDisabled();
});
