import { render, screen, fireEvent } from "@testing-library/react";
import Thumbnail from "../artifact-thumbnail";
const auth = jest.fn(({ url }) => `/authed${url}`);
jest.mock("@cocalc/frontend/project/use-project-host-authed-url", () => ({
  useProjectHostAuthedUrl: (args) => auth(args),
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ projectAccess: { role: "viewer" } }),
}));
jest.mock("@cocalc/frontend/project/viewer-file-editor", () => ({
  viewerRawFileUrl: ({ path, viewer }) => `${path}?viewer=${viewer ? 1 : 0}`,
}));
beforeEach(() => auth.mockClear());
test("uses an explicit theme image instead of loading the underlying file", () => {
  render(
    <Thumbnail
      imageBlob="12345678-1234-1234-1234-123456789012"
      projectId="project"
      path="/plot.png"
      title="Plot"
    />,
  );
  expect(
    screen.getByRole("img", { name: "Preview of Plot" }).getAttribute("src"),
  ).toContain("uuid=12345678-1234-1234-1234-123456789012");
  expect(auth).not.toHaveBeenCalled();
});
test("file fallback is viewer-aware, lazy, bounded and recovers for a new source", () => {
  const { rerender } = render(
    <Thumbnail projectId="project" path="/plot.png" title="Plot" />,
  );
  const img = screen.getByRole("img", { name: "Preview of Plot" });
  expect(img.getAttribute("src")).toBe("/authed/plot.png?viewer=1");
  expect(img.getAttribute("loading")).toBe("lazy");
  expect(img.style.objectFit).toBe("contain");
  expect(img.parentElement).toHaveStyle({ width: "48px", height: "48px" });
  fireEvent.error(img);
  expect(screen.getByText("Preview unavailable")).toBeTruthy();
  rerender(<Thumbnail projectId="project" path="/new.png" title="New plot" />);
  expect(screen.getByRole("img").getAttribute("src")).toBe(
    "/authed/new.png?viewer=1",
  );
});
