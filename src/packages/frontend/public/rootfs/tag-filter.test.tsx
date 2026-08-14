/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

import type { RootfsImageEntry } from "@cocalc/util/rootfs-images";
import { publicRootfsTags, RootfsTagFilter, RootfsTagPill } from "./tag-filter";

describe("public RootFS tags", () => {
  it("normalizes useful tags and omits catalog bookkeeping", () => {
    const entry = {
      id: "python",
      image: "python:3.14",
      label: "Python",
      tags: [
        "Python",
        "python",
        "preset:teaching",
        "project-publish",
        "source:/rootfs/catalog.json",
        "snapshot:build-123",
        "onboarding:code",
        "dev-fixture",
      ],
    } as RootfsImageEntry;

    expect(publicRootfsTags(entry)).toEqual(["python", "teaching"]);
  });

  it("renders a selected pill as a toggle", () => {
    const onToggle = jest.fn();
    render(<RootfsTagPill onToggle={onToggle} selected tag="python" />);

    const pill = screen.getByRole("button", { name: "Filter by #python" });
    expect(pill).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(pill);
    expect(onToggle).toHaveBeenCalledWith("python");
  });

  it("renders tag counts in the shared filter bar", () => {
    render(
      <RootfsTagFilter
        disabledTags={new Set(["julia"])}
        onToggle={() => {}}
        options={[
          { count: 4, tag: "jupyter" },
          { count: 1, tag: "julia" },
        ]}
        selectedTags={new Set(["jupyter"])}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Filter by #jupyter (4 families)",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Filter by #julia (1 family)" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", { name: "Filter by #julia (1 family)" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Filter by #jupyter (4 families)" }),
    ).toHaveTextContent("#jupyter 4");
  });
});
