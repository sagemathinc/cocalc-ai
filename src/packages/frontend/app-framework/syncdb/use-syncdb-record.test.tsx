import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { SyncdbContext } from "./syncdb-context";
import useSyncdbRecord from "./use-syncdb-record";

jest.useFakeTimers();

type RecordKey = {
  table: string;
  id: string;
};

type RecordValue = RecordKey & {
  value?: string;
};

function Harness({ recordKey }: { recordKey: RecordKey }) {
  const [, setRecord] = useSyncdbRecord<RecordValue>({
    key: recordKey,
    defaultValue: {
      table: recordKey.table,
      id: recordKey.id,
      value: "",
    },
    debounceMs: 50,
  });

  return (
    <button
      data-testid="set-record"
      type="button"
      onClick={() => {
        setRecord({
          table: recordKey.table,
          id: recordKey.id,
          value: `value-for-${recordKey.id}`,
        });
      }}
    >
      set
    </button>
  );
}

describe("useSyncdbRecord", () => {
  it("cancels pending debounced writes when the record key changes", async () => {
    const handlers = new Map<string, Function>();
    const syncdb = {
      get_one: jest.fn(() => undefined),
      set: jest.fn(),
      commit: jest.fn(),
      on: jest.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
      }),
      removeListener: jest.fn((event: string) => {
        handlers.delete(event);
      }),
    };

    const { getByTestId, rerender } = render(
      <SyncdbContext.Provider value={{ syncdb: syncdb as any }}>
        <Harness recordKey={{ table: "settings", id: "a" }} />
      </SyncdbContext.Provider>,
    );

    act(() => {
      getByTestId("set-record").click();
    });

    rerender(
      <SyncdbContext.Provider value={{ syncdb: syncdb as any }}>
        <Harness recordKey={{ table: "settings", id: "b" }} />
      </SyncdbContext.Provider>,
    );

    act(() => {
      jest.advanceTimersByTime(60);
    });

    await waitFor(() => {
      expect(syncdb.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ table: "settings", id: "a" }),
      );
    });
    expect(syncdb.commit).not.toHaveBeenCalled();
  });
});
