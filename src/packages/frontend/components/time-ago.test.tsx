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

  it("keeps second-level text stable until the visible text changes", () => {
    render(
      <TimeAgo
        date={new Date("2026-04-30T18:19:10.000Z")}
        click_to_toggle={false}
      />,
    );

    expect(screen.getByText("less than a minute ago")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(9 * 1000);
    });

    expect(screen.getByText("less than a minute ago")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1 * 1000);
    });

    expect(screen.getByText("1 minute ago")).toBeInTheDocument();
  });

  it("updates future timestamps at the next visible text boundary", () => {
    render(
      <TimeAgo
        date={new Date("2026-04-30T18:22:00.000Z")}
        click_to_toggle={false}
      />,
    );

    expect(screen.getByText("2 minutes from now")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(31 * 1000);
    });

    expect(screen.getByText("1 minute from now")).toBeInTheDocument();
  });

  it("continues updating as a future timestamp becomes past", () => {
    render(
      <TimeAgo
        date={new Date("2026-04-30T18:20:02.000Z")}
        click_to_toggle={false}
      />,
    );

    expect(screen.getByText("less than a minute from now")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(2 * 1000);
    });

    expect(screen.getByText("now")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("less than a minute ago")).toBeInTheDocument();
  });

  it("refreshes stale mounted timestamps when the page becomes visible", () => {
    render(
      <TimeAgo
        date={new Date("2026-04-30T18:17:00.000Z")}
        click_to_toggle={false}
      />,
    );

    expect(screen.getByText("3 minutes ago")).toBeInTheDocument();

    act(() => {
      jest.setSystemTime(new Date("2026-04-30T19:20:00.000Z"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(screen.getByText("1 hour ago")).toBeInTheDocument();
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
