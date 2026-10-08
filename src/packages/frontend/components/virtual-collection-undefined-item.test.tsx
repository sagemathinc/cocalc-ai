import { render } from "@testing-library/react";

const captured: { props?: any } = {};
jest.mock("react-virtuoso", () => {
  const capture = (props: any) => {
    captured.props = props;
    return null;
  };
  return { Virtuoso: capture, VirtuosoGrid: capture };
});

import { VirtualCollectionItems } from "./virtual-collection";

// react-virtuoso can call computeItemKey/itemContent with an undefined item
// while the data shrinks; that used to crash in itemId (e.g. the projects
// list: "Cannot read properties of undefined (reading 'project_id')").
test.each(["list", "grid"] as const)(
  "%s tolerates an undefined item from react-virtuoso",
  (view) => {
    const itemId = jest.fn((item: { project_id: string }) => item.project_id);
    const renderItem = jest.fn(
      (item: { project_id: string }) => item.project_id,
    );
    render(
      <VirtualCollectionItems
        items={[{ project_id: "p1" }]}
        itemId={itemId}
        renderItem={renderItem}
        view={view}
        loadMore={() => {}}
      />,
    );
    const { computeItemKey, itemContent } = captured.props;
    expect(computeItemKey(3, undefined)).toBe("index-3");
    expect(itemContent(3, undefined)).toBeNull();
    expect(itemId).not.toHaveBeenCalled();
    expect(renderItem).not.toHaveBeenCalled();
    expect(computeItemKey(0, { project_id: "p1" })).toBe("p1");
    expect(itemContent(0, { project_id: "p1" })).toBe("p1");
  },
);
