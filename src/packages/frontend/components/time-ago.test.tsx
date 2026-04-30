import { act, render, screen } from "@testing-library/react";
import React from "react";

import { TimeAgo } from "./time-ago";

describe("TimeAgo", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-30T18:20:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("updates relative text over time when live is enabled", () => {
    render(
      <TimeAgo
        date={new Date("2026-04-30T18:19:00.000Z")}
        click_to_toggle={false}
      />,
    );

    expect(screen.getByText("1 minute ago")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(60 * 1000);
    });

    expect(screen.getByText("2 minutes ago")).toBeInTheDocument();
  });

  it("does not recurse when many live timestamps mount together", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(
        <>
          {Array.from({ length: 80 }).map((_, i) => (
            <TimeAgo
              key={i}
              date={new Date("2026-04-30T18:19:59.000Z")}
              click_to_toggle={false}
            />
          ))}
        </>,
      );

      act(() => {
        jest.advanceTimersByTime(3 * 1000);
      });
    }).not.toThrow();

    expect(
      errorSpy.mock.calls.some((call) =>
        call.some((arg) =>
          String(arg).includes("Maximum update depth exceeded"),
        ),
      ),
    ).toBe(false);
  });
});
