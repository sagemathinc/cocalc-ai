import { render, screen, waitFor } from "@testing-library/react";

import { PublishPanel } from "./publish";

const mockShowFileActionPanel = jest.fn();
const mockListProject = jest.fn(async () => ({ shares: [] }));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({ showFileActionPanel: mockShowFileActionPanel }),
}));

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock(
  "@cocalc/frontend/course/configuration/customize-student-project-functionality",
  () => ({
    useStudentProjectFunctionality: () => ({ disableSharing: true }),
  }),
);

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        publicDirectoryShares: {
          listProject: (...args: any[]) => mockListProject(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  Loading: () => <span>Loading</span>,
}));

jest.mock("@cocalc/frontend/components/copy-button", () => () => null);
jest.mock("@cocalc/frontend/docs/navigation", () => ({
  openProjectDocs: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/directory-selector", () => () => null);

describe("PublishPanel course restrictions", () => {
  it("disables publishing while leaving permitted controls operable", async () => {
    render(<PublishPanel project_id="project-1" />);

    expect(
      screen.getByRole("button", { name: /Publish entire project/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Publish folder/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Refresh/i })).toBeEnabled();
    expect(
      screen.getByText(
        "Publishing is disabled by this course's student project settings.",
      ),
    ).toBeVisible();

    await waitFor(() => expect(mockListProject).toHaveBeenCalled());
    expect(mockShowFileActionPanel).not.toHaveBeenCalled();
  });
});
