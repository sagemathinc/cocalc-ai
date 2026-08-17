/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UltraliteSession } from "./session";
import NotificationsSurface from "./notifications-surface";

jest.mock("./session", () => ({
  UltraliteSession: { open: jest.fn() },
}));

test("renders an unread notice and marks it read", async () => {
  const markRead = jest.fn(async () => ({ updated_count: 1 }));
  const close = jest.fn();
  jest.mocked(UltraliteSession.open).mockResolvedValue({
    close,
    hubApi: {
      notifications: {
        listSnapshot: jest.fn(async () => ({
          read_through_revision: "revision-1",
          rows: [
            {
              created_at: new Date("2026-08-15T00:00:00.000Z"),
              kind: "account_notice",
              notification_id: "notice-1",
              project_id: null,
              read_state: { read: false },
              summary: {
                body_markdown: "Please review **this action**.",
                origin_label: "Security",
                title: "Review required",
              },
              updated_at: new Date("2026-08-15T00:00:00.000Z"),
            },
          ],
        })),
        markAllRead: jest.fn(),
        markRead,
      },
    },
  } as any);

  const { unmount } = render(
    <NotificationsSurface
      bootstrap={
        {
          account_id: "22222222-2222-4222-8222-222222222222",
          home_bay_url: "https://example.test",
          signed_in: true,
        } as any
      }
    />,
  );

  expect(
    await screen.findByRole("heading", { name: "Review required" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() =>
    expect(markRead).toHaveBeenCalledWith({
      notification_ids: ["notice-1"],
      read: true,
    }),
  );
  expect(screen.queryByText("Unread")).not.toBeInTheDocument();
  unmount();
  expect(close).toHaveBeenCalled();
});
