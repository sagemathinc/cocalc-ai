/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react";
import { Map, Set } from "immutable";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { STYLE } from "../../projects/hashtags";
import { HashtagBar } from "./hashtag-bar";

describe("task hashtag bar", () => {
  it("pairs theme-aware text, background, and border colors", () => {
    expect(STYLE).toMatchObject({
      background: UI_COLORS.inset,
      color: UI_COLORS.text,
      border: `1px solid ${UI_COLORS.border}`,
    });
    const { container } = render(
      <HashtagBar
        actions={{ set_hashtag_state: jest.fn() }}
        hashtags={Set(["work"])}
      />,
    );
    expect((container.firstChild as HTMLElement).style.background).toBe(
      UI_COLORS.inset,
    );
    expect((container.firstChild as HTMLElement).style.color).toBe(
      UI_COLORS.text,
    );
  });

  it("preserves selecting and clearing a hashtag", () => {
    const actions = { set_hashtag_state: jest.fn() };
    const { rerender } = render(
      <HashtagBar actions={actions} hashtags={Set(["work"])} />,
    );
    fireEvent.click(screen.getByText("#work"));
    expect(actions.set_hashtag_state).toHaveBeenLastCalledWith("work", 1);
    rerender(
      <HashtagBar
        actions={actions}
        hashtags={Set(["work"])}
        selected_hashtags={Map({ work: 1 })}
      />,
    );
    fireEvent.click(screen.getByText("#work"));
    expect(actions.set_hashtag_state).toHaveBeenLastCalledWith("work");
  });
});
