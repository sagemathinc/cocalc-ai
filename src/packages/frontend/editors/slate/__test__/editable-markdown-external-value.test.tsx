/** @jest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  EditableMarkdown,
  shouldPublishReadOnlyExternalSlateValue,
} from "../editable-markdown";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

function StreamingMarkdown({ value }: { value: string }) {
  return (
    <EditableMarkdown
      value={value}
      read_only
      enableUpload={false}
      minimal
      hidePath
      disableWindowing
      noVfill
      showEditBar={false}
      height="auto"
      autoMinHeight={0}
    />
  );
}

describe("EditableMarkdown external read-only values", () => {
  it("merges delayed independent edits in two editors without publishing echo loops", async () => {
    const base = "First paragraph.\n\nLast paragraph.";
    const merged = "Local first paragraph.\n\nRemote last paragraph.";
    const clients = [0, 1].map(() => ({
      controlRef: { current: null } as any,
      getValueRef: { current: () => "" },
      remote: base,
      setValue: jest.fn(),
    }));
    const view = () => (
      <>
        {clients.map((client, i) => (
          <EditableMarkdown
            key={i}
            value={client.remote}
            mergeRemoteValues
            getRemoteValue={() => client.remote}
            controlRef={client.controlRef}
            getValueRef={client.getValueRef}
            actions={{ set_value: client.setValue } as any}
            saveDebounceMs={10}
            is_current
            enableUpload={false}
            minimal
            hidePath
            disableWindowing
            noVfill
            showEditBar={false}
            height="auto"
          />
        ))}
      </>
    );
    const { rerender } = render(view());
    await act(async () => {
      clients[0].controlRef.current.setValueNow(
        "Local first paragraph.\n\nLast paragraph.",
      );
      clients[1].controlRef.current.setValueNow(
        "First paragraph.\n\nRemote last paragraph.",
      );
    });
    expect(clients[0].getValueRef.current()).not.toContain("Remote last");
    expect(clients[1].getValueRef.current()).not.toContain("Local first");
    clients[0].remote = "First paragraph.\n\nRemote last paragraph.";
    clients[1].remote = "Local first paragraph.\n\nLast paragraph.";
    rerender(view());
    await waitFor(() => {
      for (const client of clients)
        expect(client.getValueRef.current()).toBe(merged);
    });
    await waitFor(() => {
      for (const client of clients) {
        expect(client.setValue).toHaveBeenCalledWith(
          `${merged}\n\n`,
          undefined,
          "slate",
        );
        expect(client.setValue).toHaveBeenCalledTimes(1);
      }
    });
    for (const client of clients) {
      client.remote = `${merged}\n\n`;
      client.setValue.mockClear();
    }
    rerender(view());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    for (const client of clients) {
      expect(client.getValueRef.current()).toBe(`${merged}\n\n`);
      expect(client.setValue).not.toHaveBeenCalled();
    }
  });

  it("merges collaborative value updates with an unsaved local buffer", async () => {
    const controlRef: any = { current: null };
    const getValueRef = { current: () => "" };
    let remote = "First paragraph.\n\nLast paragraph.";
    const setValue = jest.fn();
    const props = {
      mergeRemoteValues: true,
      getRemoteValue: () => remote,
      is_current: true,
      controlRef,
      getValueRef,
      actions: { set_value: setValue } as any,
      enableUpload: false,
      minimal: true,
      hidePath: true,
      disableWindowing: true,
      noVfill: true,
      showEditBar: false,
      height: "auto",
    };
    const { rerender } = render(
      <EditableMarkdown
        {...props}
        value={"First paragraph.\n\nLast paragraph."}
      />,
    );
    await act(async () => {
      controlRef.current.setValueNow(
        "Local first paragraph.\n\nLast paragraph.",
      );
    });
    expect(getValueRef.current()).toContain("Local first paragraph.");
    remote = "First paragraph.\n\nRemote last paragraph.";
    // The backing record can change before the throttled React value prop.
    expect(getValueRef.current()).toContain("Local first paragraph.");
    expect(getValueRef.current()).toContain("Remote last paragraph.");
    rerender(
      <EditableMarkdown
        {...props}
        value={"First paragraph.\n\nRemote last paragraph."}
      />,
    );
    await waitFor(() => {
      expect(getValueRef.current()).toContain("Local first paragraph.");
      expect(getValueRef.current()).toContain("Remote last paragraph.");
    });
    await waitFor(() => {
      expect(screen.getByText("Local first paragraph.")).toBeTruthy();
      expect(screen.getByText("Remote last paragraph.")).toBeTruthy();
    });
  });

  it("pairs the document background with themed text", () => {
    const { container } = render(<StreamingMarkdown value="Theme check" />);
    expect(container.firstChild).toHaveStyle({
      backgroundColor: UI_COLORS.surface,
      color: UI_COLORS.text,
    });
    expect(container.querySelector("[data-slate-editor]")).toHaveStyle({
      background: UI_COLORS.surface,
      color: UI_COLORS.text,
    });
  });
  it("never uses the forced publication path for collaborative editors", () => {
    expect(
      shouldPublishReadOnlyExternalSlateValue({
        readOnly: false,
        hasSyncstring: true,
      }),
    ).toBe(false);
    expect(
      shouldPublishReadOnlyExternalSlateValue({
        readOnly: true,
        hasSyncstring: true,
      }),
    ).toBe(false);
    expect(
      shouldPublishReadOnlyExternalSlateValue({
        readOnly: true,
        hasSyncstring: false,
      }),
    ).toBe(true);
  });

  it("renders the final value after rapid streaming updates", async () => {
    const { rerender } = render(
      <StreamingMarkdown value="Progress update: I'll run" />,
    );

    act(() => {
      rerender(
        <StreamingMarkdown value="Progress update: I'll run exactly three" />,
      );
      rerender(
        <StreamingMarkdown value="Progress update: I'll run exactly three independent, read-only commands." />,
      );
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Progress update: I'll run exactly three independent, read-only commands.",
        ),
      ).toBeTruthy();
    });
  });

  it("keeps rendering after a stream crosses the direct-set threshold", async () => {
    const { rerender } = render(<StreamingMarkdown value="Starting stream." />);
    const longActivity = Array.from(
      { length: 260 },
      (_, index) => `Activity block ${index + 1}.`,
    ).join("\n\n");

    rerender(<StreamingMarkdown value={longActivity} />);

    await waitFor(() => {
      expect(screen.getByText("Activity block 260.")).toBeTruthy();
    });

    rerender(
      <StreamingMarkdown
        value={`${longActivity}\n\nLatest activity after direct replacement.`}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Latest activity after direct replacement."),
      ).toBeTruthy();
    });
  });
});
