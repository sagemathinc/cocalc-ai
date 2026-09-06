/** @jest-environment jsdom */

import { fireEvent, render, screen, act } from "@testing-library/react";
import { fromJS } from "immutable";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { CreateAssignmentToolbar } from "./cell-toolbar-create-assignment";

jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/frame-editors/frame-tree/print", () => ({
  popup: jest.fn(),
}));

it("uses paired colors and keeps points and ID fields editable", () => {
  jest.useFakeTimers();
  const set_metadata = jest.fn();
  const ensure_grade_ids_are_unique = jest.fn();
  const actions = {
    nbgrader_actions: { set_metadata, ensure_grade_ids_are_unique },
  } as any;
  const cell = fromJS({
    id: "cell",
    cell_type: "code",
    metadata: {
      nbgrader: {
        grade: true,
        solution: true,
        locked: false,
        task: false,
        remove: false,
        points: 10,
        grade_id: "answer",
      },
    },
  });
  const { container } = render(
    <CreateAssignmentToolbar actions={actions} cell={cell} />,
  );
  expect((container.firstChild as HTMLElement).style.background).toBe(
    UI_COLORS.primary,
  );
  expect((container.firstChild as HTMLElement).style.color).toBe(
    UI_COLORS.onPrimary,
  );
  const points = screen.getByRole("textbox", { name: "Points" });
  const id = screen.getByRole("textbox", { name: "Grade ID" });
  for (const input of [points, id]) {
    expect(input.style.color).toBe(UI_COLORS.text);
    expect(input.style.background).toBe(UI_COLORS.surface);
    input.focus();
    expect(input).toHaveFocus();
  }
  fireEvent.change(points, { target: { value: "12" } });
  fireEvent.change(id, { target: { value: "answer 2" } });
  act(() => jest.advanceTimersByTime(2100));
  expect(set_metadata).toHaveBeenCalledWith("cell", { points: 12 });
  expect(set_metadata).toHaveBeenCalledWith("cell", { grade_id: "answer2" });
  expect(ensure_grade_ids_are_unique).toHaveBeenCalled();
  jest.useRealTimers();
});
