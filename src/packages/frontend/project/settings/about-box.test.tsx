import { render, screen } from "@testing-library/react";
import { AboutBox } from "./about-box";
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
  createIntlCache: () => ({}),
  createIntl: () => ({
    formatMessage: ({ defaultMessage, id }: any) => defaultMessage ?? id ?? "",
  }),
  defineMessage: (message: any) => message,
  defineMessages: (messages: any) => messages,
  useIntl: () => ({
    formatMessage: ({ defaultMessage, id }: any) => defaultMessage ?? id ?? "",
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useTypedRedux: (...args: any[]) => useTypedRedux(...args),
  };
});

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

jest.mock("@cocalc/frontend/projects/use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({
    isProjectBookmarked: () => false,
    setProjectBookmarked: jest.fn(),
  }),
}));

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
      getIn: (path: string[]) => {
        if (path[path.length - 1] === "avatar_image_tiny") {
          return "blob-1";
        }
        if (path[path.length - 1] === "color") {
          return "#112233";
        }
        return undefined;
      },
    });
  });

  it("renders the current blob-backed project image preview", () => {
    render(
      <AboutBox
        project_id="project-1"
        project_title="Project 1"
        description=""
        actions={actions}
        mode="flyout"
      />,
    );

    expect(
      screen.getByTestId("project-appearance-image").getAttribute("src"),
    ).toContain("uuid=blob-1");
  });
});
