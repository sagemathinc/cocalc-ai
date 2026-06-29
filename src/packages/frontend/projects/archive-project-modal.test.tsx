/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ArchiveProjectModal } from "./archive-project-modal";

jest.mock("antd", () => ({
  Alert: ({ message, description }: any) => (
    <div>
      <div>{message}</div>
      <div>{description}</div>
    </div>
  ),
  Button: ({ children, loading: _loading, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Modal: ({ children, footer, open, title }: any) =>
    open ? (
      <div>
        <div>{title}</div>
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
  Space: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("react-intl", () => ({
  defineMessage: (message: any) => message,
  defineMessages: (messages: any) => messages,
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: any) => defaultMessage ?? "",
  }),
}));

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span data-icon={name} />,
}));

jest.mock("./hard-delete-project-modal", () => ({
  IconBadge: ({ icon }: any) => <span data-icon={icon} />,
  InfoRow: ({ children, icon }: any) => (
    <div>
      <span data-icon={icon} />
      {children}
    </div>
  ),
  InfoSection: ({ children, icon, title }: any) => (
    <section>
      <span data-icon={icon} />
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

describe("ArchiveProjectModal", () => {
  it("explains archive as a reversible storage cleanup operation", () => {
    const { container } = render(
      <ArchiveProjectModal
        open
        projects={[
          {
            project_id: "project-1",
            title: "Research Archive",
            state: "running",
          },
        ]}
        onCancel={jest.fn()}
        onArchive={jest.fn()}
      />,
    );

    expect(container).toHaveTextContent(
      "Free active storage while keeping files recoverable.",
    );
    expect(container).toHaveTextContent("Why archive");
    expect(container).toHaveTextContent(
      "Frees active project-host storage and compute resources.",
    );
    expect(container).toHaveTextContent(
      "This project is running, so CoCalc will stop it before making the final backup.",
    );
    expect(container).toHaveTextContent(
      "Remove the active host copy and filesystem snapshots; backups are kept so the project can be restored later.",
    );
  });

  it("warns when archive is only available through the admin bypass", () => {
    const { container } = render(
      <ArchiveProjectModal
        open
        projects={[
          {
            project_id: "project-1",
            title: "Collaborator Project",
            state: "opened",
            archiveAllowedByAdminOnly: true,
          },
        ]}
        onCancel={jest.fn()}
        onArchive={jest.fn()}
      />,
    );

    expect(container).toHaveTextContent(
      "Archive is available because you are an administrator",
    );
    expect(container).toHaveTextContent(
      "The owner has not enabled Storage history for collaborators on this project.",
    );
  });

  it("warns when archived projects have public shares", () => {
    const { container } = render(
      <ArchiveProjectModal
        open
        projects={[
          {
            project_id: "project-1",
            title: "Published Project",
            state: "opened",
            publicShareCount: 2,
          },
        ]}
        onCancel={jest.fn()}
        onArchive={jest.fn()}
      />,
    );

    expect(container).toHaveTextContent(
      "Public shares are not available when a project is archived.",
    );
    expect(container).toHaveTextContent(
      "This project has public shares. They will not be accessible again until the project is restored.",
    );
  });

  it("shows batch-specific state and skipped-project copy", () => {
    const { container } = render(
      <ArchiveProjectModal
        open
        projects={[
          {
            project_id: "project-1",
            title: "Running Project",
            state: "running",
          },
          {
            project_id: "project-2",
            title: "Stopped Project",
            state: "opened",
          },
        ]}
        skippedCount={1}
        onCancel={jest.fn()}
        onArchive={jest.fn()}
      />,
    );

    expect(container).toHaveTextContent("Archive 2 projects");
    expect(container).toHaveTextContent(
      "1 selected projects are running or starting, so CoCalc will stop those before making final backups.",
    );
    expect(container).toHaveTextContent("Selected projects");
    expect(container).toHaveTextContent("Running Project");
    expect(container).toHaveTextContent("Stopped Project");
    expect(container).toHaveTextContent("1 selected projects will be skipped");
  });

  it("archives the selected project ids and closes immediately", async () => {
    const onCancel = jest.fn();
    const onArchive = jest.fn(async () => undefined);
    render(
      <ArchiveProjectModal
        open
        projects={[
          { project_id: "project-1", title: "One", state: "opened" },
          { project_id: "project-2", title: "Two", state: "opened" },
        ]}
        onCancel={onCancel}
        onArchive={onArchive}
      />,
    );

    fireEvent.click(screen.getByText("Archive Projects"));

    expect(onCancel).toHaveBeenCalled();
    await waitFor(() =>
      expect(onArchive).toHaveBeenCalledWith(["project-1", "project-2"]),
    );
  });
});
