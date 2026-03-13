import { act, render, screen, waitFor } from "@testing-library/react";
import { AboutBox } from "./about-box";

const getProjectAvatarImage = jest.fn();
const useTypedRedux = jest.fn();

jest.mock("antd", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  return {
    Alert: Div,
    Button,
    Col: Div,
    Flex: Div,
    Modal: Div,
    Row: Div,
    Typography: {
      Text: Div,
    },
  };
});

jest.mock("react-intl", () => ({
  defineMessage: (message: any) => message,
  defineMessages: (messages: any) => messages,
  useIntl: () => ({
    formatMessage: ({ defaultMessage, id }: any) => defaultMessage ?? id ?? "",
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      getProjectAvatarImage: (...args: any[]) => getProjectAvatarImage(...args),
    }),
  },
  useTypedRedux: (...args: any[]) => useTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);

jest.mock("@cocalc/frontend/components", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  return {
    CopyToClipBoard: Div,
    HelpIcon: Div,
    Icon: Div,
    LabeledRow: Div,
    Paragraph: Div,
    SettingBox: Div,
    TextInput: Div,
    ThemeEditorModal: Div,
    TimeAgo: Div,
  };
});

jest.mock("@cocalc/frontend/account/avatar/font-color", () => ({
  avatar_fontcolor: () => "#000",
}));

jest.mock("@cocalc/frontend/colorpicker", () => ({
  ColorPicker: () => null,
}));

jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: () => null,
}));

jest.mock("./image", () => ({
  __esModule: true,
  default: ({ avatarImage }: any) => (
    <div data-testid="avatar-image">{avatarImage ?? ""}</div>
  ),
}));

jest.mock("@cocalc/frontend/projects/use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({
    isProjectBookmarked: () => false,
    setProjectBookmarked: jest.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("AboutBox", () => {
  const actions = {
    set_project_title: jest.fn(),
    set_project_description: jest.fn(),
    set_project_name: jest.fn(),
    setProjectImage: jest.fn(),
    setProjectColor: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    useTypedRedux.mockReturnValue({
      getIn: () => undefined,
    });
  });

  it("reloads and ignores stale avatar results when the project changes", async () => {
    const first = deferred<string | undefined>();
    const second = deferred<string | undefined>();
    getProjectAvatarImage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(
      <AboutBox
        project_id="project-1"
        project_title="Project 1"
        description=""
        actions={actions}
        mode="flyout"
      />,
    );

    rerender(
      <AboutBox
        project_id="project-2"
        project_title="Project 2"
        description=""
        actions={actions}
        mode="flyout"
      />,
    );

    await act(async () => {
      second.resolve("second.png");
      await second.promise;
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("project-appearance-image").getAttribute("src"),
      ).toBe("second.png");
    });

    await act(async () => {
      first.resolve("first.png");
      await first.promise;
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("project-appearance-image").getAttribute("src"),
      ).toBe("second.png");
    });
  });
});
