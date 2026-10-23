/** @jest-environment jsdom */

import { render, act } from "@testing-library/react";
import { Transforms } from "slate";
import useUpload from "../upload";

let handlers: any;
const mockAddFile = jest.fn();
let mockDropzoneAvailable = true;
jest.mock("@cocalc/frontend/file-upload", () => ({
  BlobUpload: ({ event_handlers, dropzone_ref, children }) => {
    handlers = event_handlers;
    dropzone_ref.current = mockDropzoneAvailable
      ? { addFile: mockAddFile }
      : null;
    return children;
  },
}));
jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({ project_id: "project", path: "chat" }),
}));
jest.mock("../format/commands", () => ({ getFocus: () => undefined }));
jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));
jest.mock("slate", () => ({ Transforms: { insertFragment: jest.fn() } }));

function Harness({ start, end, editor = { insertData: jest.fn() } }) {
  return useUpload(editor as any, <div />, {
    onUploadStart: start,
    onUploadEnd: end,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDropzoneAvailable = true;
});

describe("pasted image bytes", () => {
  it.each([
    ["one byte / two padding characters", "AQ==", "image/png", ".png"],
    ["two bytes / one padding character", "Af8=", "image/jpeg", ".jpg"],
    ["three bytes / no padding", "Af+A", "image/gif", ".gif"],
    [
      "complete one-pixel PNG",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "image/png",
      ".png",
    ],
  ])("preserves %s", async (_label, base64, type, extension) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const original = new File([bytes], "clipboard", {
      type: "application/octet-stream",
    });
    const fallback = jest.fn();
    const editor = { insertData: fallback, __uploadGeneration: 7 };
    render(<Harness start={jest.fn()} end={jest.fn()} editor={editor} />);
    const laterImage = { type, getAsFile: jest.fn(() => original) };

    act(() => {
      editor.insertData({
        items: [{ type, getAsFile: () => original }, laterImage],
      });
    });

    expect(fallback).not.toHaveBeenCalled();
    expect(laterImage.getAsFile).not.toHaveBeenCalled();
    expect(mockAddFile).toHaveBeenCalledTimes(1);
    const uploaded: File = mockAddFile.mock.calls[0][0];
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded.size).toBe(original.size);
    expect(uploaded.type).toBe(type);
    expect(uploaded.name.startsWith("paste-")).toBe(true);
    expect(uploaded.name.endsWith(extension)).toBe(true);
    expect((uploaded as any)._slateUploadGeneration).toBe(7);

    const actual = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(uploaded);
    });
    expect(new Uint8Array(actual)).toEqual(bytes);
    expect(new Uint8Array(actual).at(-1)).toBe(bytes.at(-1));
    const dataURL = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(uploaded);
    });
    expect(dataURL).toBe(`data:${type};base64,${base64}`);
  });

  it("retains non-image and unavailable-dropzone fallback", () => {
    const fallback = jest.fn();
    const editor = { insertData: fallback };
    const { unmount } = render(
      <Harness start={jest.fn()} end={jest.fn()} editor={editor} />,
    );
    const text = { items: [{ type: "text/plain" }] };
    act(() => editor.insertData(text));
    expect(fallback).toHaveBeenCalledWith(text);
    expect(mockAddFile).not.toHaveBeenCalled();
    unmount();

    mockDropzoneAvailable = false;
    const secondFallback = jest.fn();
    const secondEditor = { insertData: secondFallback };
    render(<Harness start={jest.fn()} end={jest.fn()} editor={secondEditor} />);
    const image = { items: [{ type: "image/png", getAsFile: jest.fn() }] };
    act(() => secondEditor.insertData(image));
    expect(secondFallback).toHaveBeenCalledWith(image);
    expect(image.items[0].getAsFile).not.toHaveBeenCalled();
  });

  it("retains null-file and first-image-only behavior", () => {
    const fallback = jest.fn();
    const editor = { insertData: fallback };
    render(<Harness start={jest.fn()} end={jest.fn()} editor={editor} />);
    const laterImage = {
      type: "image/png",
      getAsFile: jest.fn(() => new File(["later"], "later.png")),
    };
    act(() => {
      editor.insertData({
        items: [{ type: "image/png", getAsFile: () => null }, laterImage],
      });
    });
    expect(mockAddFile).not.toHaveBeenCalled();
    expect(laterImage.getAsFile).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});

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
