/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { EventEmitter } from "events";
import { createRef } from "react";

import type {
  SharedBrowserState,
  ViewerMessage,
} from "@cocalc/util/shared-browser-protocol";

const connections: FakeConnection[] = [];

class FakeConnection extends EventEmitter {
  sent: ViewerMessage[] = [];
  constructor(
    readonly project_id: string,
    readonly appId: string,
    readonly hello: any,
  ) {
    super();
    connections.push(this);
  }
  send(msg: ViewerMessage) {
    this.sent.push(msg);
  }
  async startPage() {
    return {
      servers: [{ port: 5173, url: "http://localhost:5173/", label: "vite" }],
      recent: [],
    };
  }
  async favicon() {
    return null;
  }
  close() {}
}

jest.mock("./connection", () => ({
  SharedBrowserConnection: jest.fn(
    (project_id: string, appId: string, hello: any) =>
      new FakeConnection(project_id, appId, hello),
  ),
}));

jest.mock("./screen", () => ({
  BrowserScreen: class {
    lastCopy = { text: "", at: 0 };
    destroy() {}
    connected() {}
    clear() {}
    focus() {}
    setSelection() {}
    sendSize() {}
    picture() {
      return null;
    }
    copy() {
      return Promise.resolve();
    }
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { browser_id: "page-1" },
}));

import { SharedBrowserViewer, type SharedBrowserControl } from "./viewer";

function browserState(
  overrides: Partial<SharedBrowserState> = {},
): SharedBrowserState {
  return {
    driver: "agent",
    ask: null,
    tabs: [{ id: "t1", url: "https://example.com/", title: "Example" }],
    active: "t1",
    viewport: { width: 800, height: 600 },
    dialog: null,
    select: null,
    fileChooser: null,
    agents: 1,
    agentWaiting: false,
    cdp: "",
    viewers: 1,
    connection: "connected",
    runsOn: null,
    connectCommand: null,
    title: "Web browser",
    zoom: 1,
    network: null,
    ...overrides,
  };
}

function open(props: Partial<Parameters<typeof SharedBrowserViewer>[0]> = {}) {
  connections.length = 0;
  const result = render(
    <SharedBrowserViewer
      project_id="p1"
      appId="cocalc-browser"
      view="card:a"
      {...props}
    />,
  );
  const connection = connections[0];
  const show = (state: SharedBrowserState) =>
    act(() => {
      connection.emit("state", state);
    });
  return { ...result, connection, show };
}

describe("SharedBrowserViewer", () => {
  it("connects for its place, and says who drives", () => {
    const { connection, show } = open();
    expect(connection.project_id).toBe("p1");
    expect(connection.hello).toEqual({
      view: "card:a",
      client: "page-1",
      site: window.location.origin,
    });
    show(browserState());
    expect(screen.getByText("The agent is driving.")).toBeTruthy();
    fireEvent.click(screen.getByText("Take over"));
    expect(connection.sent).toContainEqual({ type: "takeover" });
    // Not driving: no new tab, and the address bar is read only.
    expect(screen.queryByTitle("New tab")).toBeNull();
  });

  it("asks for the human when the agent does, and hands back", () => {
    const { connection, show } = open();
    show(
      browserState({
        ask: { message: "please sign in", at: "2026-10-10T00:00:00Z" },
      }),
    );
    expect(
      screen.getByText("The agent asks you to take over: please sign in"),
    ).toBeTruthy();
    show(browserState({ driver: "human" }));
    expect(
      screen.getByText("You are driving. The agent waits until you hand back."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Hand back to agent"));
    expect(connection.sent).toContainEqual({ type: "handback" });
  });

  it("shows tabs, switches and opens them while driving", () => {
    const { connection, show } = open();
    show(
      browserState({
        driver: "human",
        tabs: [
          { id: "t1", url: "https://example.com/", title: "Example" },
          { id: "t2", url: "https://cocalc.ai/", title: "CoCalc" },
        ],
      }),
    );
    fireEvent.click(screen.getByText("CoCalc"));
    expect(connection.sent).toContainEqual({ type: "tab", id: "t2" });
    fireEvent.click(screen.getByTitle("New tab"));
    expect(connection.sent).toContainEqual({ type: "newTab" });
  });

  it("offers a new tab's start page with the project's servers", async () => {
    const onReady = jest.fn();
    const onAskAgent = jest.fn();
    const { connection, show } = open({ onReady, onAskAgent });
    show(
      browserState({
        driver: "human",
        tabs: [{ id: "t1", url: "about:blank", title: "" }],
      }),
    );
    expect(onReady).toHaveBeenCalled();
    expect(await screen.findByText("localhost:5173")).toBeTruthy();
    fireEvent.click(screen.getByText("localhost:5173"));
    expect(connection.sent).toContainEqual({
      type: "navigate",
      url: "http://localhost:5173/",
    });
    const task = screen.getByPlaceholderText(/sign-up flow/);
    fireEvent.change(task, { target: { value: "check the login" } });
    fireEvent.submit(task.closest("form")!);
    expect(onAskAgent).toHaveBeenCalledWith("check the login");
  });

  it("answers the page's dialogs while driving", () => {
    const { connection, show } = open();
    show(
      browserState({
        driver: "human",
        dialog: { type: "prompt", message: "Your name?", defaultPrompt: "Ada" },
      }),
    );
    expect(screen.getByText("Your name?")).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("Ada"), {
      target: { value: "Grace" },
    });
    fireEvent.click(screen.getByText("OK"));
    expect(connection.sent).toContainEqual({
      type: "dialog",
      accept: true,
      promptText: "Grace",
    });
  });

  it("tells the page around it where a file's browser runs, and switches it", () => {
    const onRemote = jest.fn();
    const controlRef = createRef<SharedBrowserControl | null>() as any;
    const { connection, show } = open({
      onRemote,
      controlRef,
      hostPanel: true,
    });
    show(
      browserState({
        runsOn: "computer",
        connection: "waiting",
        connectCommand: "cocalc project browser connect",
      }),
    );
    expect(onRemote).toHaveBeenLastCalledWith({
      runsOn: "computer",
      connection: "waiting",
      connectCommand: "cocalc project browser connect",
    });
    // The page around it draws the waiting panel.
    expect(screen.queryByText(/Waiting for your computer/)).toBeNull();
    controlRef.current.setRunsOn("project");
    expect(connection.sent).toContainEqual({
      type: "runsOn",
      value: "project",
    });
  });

  it("offers the project's network to a browser with its own", async () => {
    const { connection, show } = open();
    show(
      browserState({
        driver: "human",
        network: "own",
        tabs: [{ id: "t1", url: "about:blank", title: "" }],
      }),
    );
    expect(
      await screen.findByText(/cannot reach this project's servers/),
    ).toBeTruthy();
    // Its servers wait for the switch.
    fireEvent.click(await screen.findByText("localhost:5173"));
    expect(connection.sent.some((m) => m.type === "navigate")).toBe(false);
    fireEvent.click(screen.getByText("Connect to this project's network"));
    expect(connection.sent).toContainEqual({
      type: "network",
      value: "project",
    });
  });
});
