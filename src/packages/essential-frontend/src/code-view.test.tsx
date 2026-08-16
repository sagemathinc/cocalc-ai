/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import CodeView from "./code-view";
import type { ExternalMergeHandle } from "./external-merge";
import { navigate } from "./routes";
import {
  editJournalAvailable,
  saveTextJournal,
} from "@cocalc/conat/project/edit-journal";

jest.mock("@cocalc/conat/project/edit-journal", () => ({
  editJournalAvailable: jest.fn(async () => true),
  saveTextJournal: jest.fn(),
}));

jest.mock("./sha256", () => ({
  sha256Text: jest.fn(async () => "a".repeat(64)),
}));

jest.mock("./codemirror-editor", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: React.forwardRef((props: any, ref: any) => {
      const [value, setValue] = React.useState(props.initialValue);
      const valueRef = React.useRef(value);
      valueRef.current = value;
      React.useEffect(() => setValue(props.initialValue), [props.initialValue]);
      React.useImperativeHandle(ref, () => ({
        acknowledgeJournal: setValue,
        focus: jest.fn(),
        getJournalBatch: () =>
          valueRef.current === props.initialValue
            ? undefined
            : {
                base: props.initialValue,
                value: valueRef.current,
                patch: [
                  [
                    [
                      [-1, props.initialValue],
                      [1, valueRef.current],
                    ],
                    0,
                    0,
                    props.initialValue.length,
                    valueRef.current.length,
                  ],
                ],
              },
        getValue: () => valueRef.current,
        markClean: jest.fn(),
        rebaseValue: (_base: string, next: string) => {
          valueRef.current = next;
          setValue(next);
        },
        replaceValue: setValue,
      }));
      return (
        <textarea
          aria-label={props.ariaLabel}
          onChange={(event) => {
            setValue(event.target.value);
            props.onDirtyChange(event.target.value !== props.initialValue);
          }}
          value={value}
        />
      );
    }),
  };
});

jest.mock("./markdown-view", () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => (
    <article aria-label="Rendered Markdown">{source}</article>
  ),
}));

function props(writeFileIfUnchanged = jest.fn(async () => undefined)) {
  return {
    contents: "old\n",
    filesystem: { writeFileIfUnchanged } as any,
    onDirtyChange: jest.fn(),
    onSaved: jest.fn(),
    path: "/home/user/notes.txt",
    readOnly: false,
  };
}

afterEach(() => {
  editJournalAvailableMock.mockReset().mockResolvedValue(true);
  saveTextJournalMock.mockReset();
  jest.restoreAllMocks();
});

const saveTextJournalMock = jest.mocked(saveTextJournal);
const editJournalAvailableMock = jest.mocked(editJournalAvailable);

test("saves exactly against the version that was opened", async () => {
  const value = props();
  render(<CodeView {...value} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
    {
      target: { value: "new\n" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(value.filesystem.writeFileIfUnchanged).toHaveBeenCalledWith(
      "/home/user/notes.txt",
      "new\n",
      "old\n",
      true,
    ),
  );
  expect(value.onSaved).toHaveBeenCalledWith("new\n");
  expect(await screen.findByText("Saved.")).toBeVisible();
});

test("keeps the draft and blocks overwrite after an etag conflict", async () => {
  const conflict = Object.assign(new Error("changed"), {
    code: "ETAG_MISMATCH",
  });
  const value = props(jest.fn(async () => Promise.reject(conflict)));
  render(<CodeView {...value} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
    {
      target: { value: "my draft\n" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(
    await screen.findByText(/changed on the server after you opened it/),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Edit notes.txt" })).toHaveValue(
    "my draft\n",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(value.filesystem.writeFileIfUnchanged).toHaveBeenCalledTimes(1);
});

test("merges independent disk edits and saves against the newer base", async () => {
  const value = {
    ...props(),
    contents: "one\ntwo\nthree\n",
  };
  const ref = createRef<ExternalMergeHandle>();
  render(<CodeView {...value} ref={ref} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
    { target: { value: "local\ntwo\nthree\n" } },
  );

  let result;
  act(() => {
    result = ref.current?.mergeExternal("one\ntwo\nremote\n");
  });

  expect(result).toEqual({ clean: true, dirty: true });
  expect(screen.getByRole("textbox", { name: "Edit notes.txt" })).toHaveValue(
    "local\ntwo\nremote\n",
  );
  expect(screen.getByText(/merged into your draft/i)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(value.filesystem.writeFileIfUnchanged).toHaveBeenCalledWith(
      "/home/user/notes.txt",
      "local\ntwo\nremote\n",
      "one\ntwo\nremote\n",
      true,
    ),
  );
});

test("retains the draft unchanged when the same text changed on disk", async () => {
  const value = {
    ...props(),
    contents: "one\ntwo\n",
  };
  const ref = createRef<ExternalMergeHandle>();
  render(<CodeView {...value} ref={ref} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
    { target: { value: "one\nlocal\n" } },
  );

  let result;
  act(() => {
    result = ref.current?.mergeExternal("one\nremote\n");
  });

  expect(result).toEqual({
    clean: false,
    message: "Automatic merging was unsafe. Your draft was retained unchanged.",
  });
  expect(screen.getByRole("textbox", { name: "Edit notes.txt" })).toHaveValue(
    "one\nlocal\n",
  );
  expect(screen.getByText(/use Full CoCalc to resolve/i)).toBeVisible();
});

test("saves editor operations through the project-host journal", async () => {
  saveTextJournalMock.mockResolvedValue({
    committed: true,
    contents: "new\n",
    sha256: "hash",
    time: "patch-1",
  });
  const value = {
    ...props(),
    project: {
      host_id: "host-1",
      project_id: "11111111-1111-4111-8111-111111111111",
    } as any,
    session: {
      accountId: "00000000-0000-4000-8000-000000000001",
      openProjectHost: jest.fn(async () => ({ client: {} })),
    } as any,
  };
  render(<CodeView {...value} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
    { target: { value: "new\n" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(saveTextJournalMock).toHaveBeenCalledTimes(1));
  expect(value.filesystem.writeFileIfUnchanged).not.toHaveBeenCalled();
  expect(saveTextJournalMock).toHaveBeenCalledWith(
    expect.objectContaining({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "11111111-1111-4111-8111-111111111111",
      request: expect.objectContaining({
        path: "/home/user/notes.txt",
        sequence: 0,
      }),
    }),
  );
});

test("falls back safely while a project host lacks the journal service", async () => {
  editJournalAvailableMock.mockResolvedValue(false);
  const value = {
    ...props(),
    project: {
      host_id: "host-1",
      project_id: "11111111-1111-4111-8111-111111111111",
    } as any,
    session: {
      accountId: "00000000-0000-4000-8000-000000000001",
      openProjectHost: jest.fn(async () => ({ client: {} })),
    } as any,
  };
  render(<CodeView {...value} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
    { target: { value: "new\n" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(value.filesystem.writeFileIfUnchanged).toHaveBeenCalledTimes(1),
  );
  expect(saveTextJournalMock).not.toHaveBeenCalled();
});

test("can cancel constrained-client navigation while dirty", async () => {
  const value = props();
  jest.spyOn(window, "confirm").mockReturnValue(false);
  window.history.replaceState({}, "", "/essential/projects");
  render(<CodeView {...value} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
    {
      target: { value: "dirty" },
    },
  );

  navigate({
    kind: "files",
    projectId: "11111111-1111-4111-8111-111111111111",
    path: "/home/user",
  });

  expect(window.location.pathname).toBe("/essential/projects");
});

test("replaces the editor document when a different file is opened", async () => {
  const value = props();
  const { rerender } = render(<CodeView {...value} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    await screen.findByRole("textbox", { name: "Edit notes.txt" }),
  ).toHaveValue("old\n");

  rerender(
    <CodeView {...value} contents={"second\n"} path="/home/user/second.txt" />,
  );

  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Edit second.txt" }),
    ).toHaveValue("second\n"),
  );
});

test("renders Markdown instead of showing its source by default", async () => {
  render(
    <CodeView
      {...props()}
      contents="# A heading\n\n$e^{i\\pi}+1=0$"
      path="/home/user/README.md"
    />,
  );

  expect(
    await screen.findByRole("article", { name: "Rendered Markdown" }),
  ).toHaveTextContent("# A heading");
  expect(screen.queryByText("markdown")).toBeInTheDocument();
});
