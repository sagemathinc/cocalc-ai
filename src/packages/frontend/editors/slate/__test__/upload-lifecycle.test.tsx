/** @jest-environment jsdom */

import { render, act } from "@testing-library/react";
import { Transforms } from "slate";
import useUpload from "../upload";

let handlers: any;
jest.mock("@cocalc/frontend/file-upload", () => ({
  BlobUpload: ({ event_handlers, children }) => {
    handlers = event_handlers;
    return children;
  },
}));
jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({ project_id: "project", path: "chat" }),
}));
jest.mock("../format/commands", () => ({ getFocus: () => undefined }));
jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));
jest.mock("slate", () => ({ Transforms: { insertFragment: jest.fn() } }));

function Harness({ start, end }) {
  return useUpload({ insertData: jest.fn() } as any, <div />, {
    onUploadStart: start,
    onUploadEnd: end,
  });
}

it("keeps an image pending until its dimensions and Slate insertion finish", async () => {
  const start = jest.fn();
  const end = jest.fn();
  let image: any;
  const original = global.Image;
  global.Image = jest.fn().mockImplementation(() => (image = {})) as any;
  const { unmount } = render(<Harness start={start} end={end} />);
  try {
    const file = {
      upload: { uuid: "one", chunks: [{ file: { type: "image/png" } }] },
    };
    handlers.addedfile(file);
    const complete = handlers.complete({ ...file, url: "/blobs/image" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
    await act(async () => {
      image.onload();
      await complete;
    });
    expect(Transforms.insertFragment).toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
    global.Image = original;
  }
});

it("balances failures, cancellations and unmount without double completion", async () => {
  const start = jest.fn();
  const end = jest.fn();
  const { unmount } = render(<Harness start={start} end={end} />);
  const file = { upload: { uuid: "failed" } };
  handlers.addedfile(file);
  handlers.error(file, "Upload failed");
  await handlers.complete({ ...file });
  expect(end).toHaveBeenCalledTimes(1);
  handlers.addedfile({ upload: { uuid: "canceled" } });
  handlers.canceled({ upload: { uuid: "canceled" } });
  handlers.addedfile({ upload: { uuid: "pending" } });
  unmount();
  expect(start).toHaveBeenCalledTimes(3);
  expect(end).toHaveBeenCalledTimes(3);
});
