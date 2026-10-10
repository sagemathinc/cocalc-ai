/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A new tab's start page: search or an address, the web servers running in
// the project (one click to your dev server), sites visited recently, and
// asking an agent.

import { useEffect, useRef, useState } from "react";

import type { StartPageData } from "@cocalc/util/shared-browser-protocol";

import type { SharedBrowserConnection } from "./connection";
import { useIcon } from "./icons";
import { isApple } from "./input";

const COLORS = [
  "#722ed1",
  "#fa8c16",
  "#13c2c2",
  "#1677ff",
  "#eb2f96",
  "#52c41a",
  "#2f54eb",
  "#fa541c",
];

function colorOf(text: string): string {
  const hash = [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return COLORS[hash % COLORS.length];
}

function Badge({ text, colorKey }: { text: string; colorKey: string }) {
  return (
    <span className="cc-sbv-sp-badge" style={{ background: colorOf(colorKey) }}>
      {text}
    </span>
  );
}

const GLOBE = (
  <svg viewBox="0 0 64 64" fill="none" strokeWidth="2.6">
    <defs>
      <linearGradient id="cc-sbv-globe" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#1677ff" />
        <stop offset="1" stopColor="#13c2c2" />
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="26" stroke="url(#cc-sbv-globe)" />
    <ellipse cx="32" cy="32" rx="11" ry="26" stroke="url(#cc-sbv-globe)" />
    <path d="M6 32h52M10 19h44M10 45h44" stroke="url(#cc-sbv-globe)" />
  </svg>
);

function RecentTile({
  connection,
  url,
  title,
  go,
}: {
  connection: SharedBrowserConnection;
  url: string;
  title: string;
  go: (url: string) => void;
}) {
  let host = url;
  let origin = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, "");
    origin = parsed.origin;
  } catch {}
  const icon = useIcon(
    connection,
    origin ? `${origin}/favicon.ico` : undefined,
  );
  return (
    <button
      type="button"
      className="cc-sbv-sp-tile"
      title={url}
      onClick={() => go(url)}
    >
      {icon ? (
        <img src={icon} alt="" />
      ) : (
        <Badge text={host.slice(0, 1).toUpperCase()} colorKey={host} />
      )}
      <b>{title || host}</b>
      <small>{host}</small>
    </button>
  );
}

export function StartPage({
  connection,
  name,
  driving,
  canRunOnComputer,
  go,
  onAskAgent,
  flash,
}: {
  connection: SharedBrowserConnection;
  name: string;
  driving: boolean;
  canRunOnComputer: boolean;
  go: (text: string) => void;
  onAskAgent?: (text: string) => void;
  flash: (text: string) => void;
}) {
  const [data, setData] = useState<StartPageData>({ servers: [], recent: [] });
  const [query, setQuery] = useState("");
  const [task, setTask] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let canceled = false;
    void connection
      .startPage()
      .then((value) => {
        if (!canceled) setData(value);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [connection]);
  useEffect(() => {
    if (driving) search.current?.focus({ preventScroll: true });
  }, [driving]);
  const apple = isApple();
  return (
    <div className="cc-sbv-start">
      <div className="cc-sbv-sp">
        <div className="cc-sbv-sp-logo">
          {GLOBE}
          <h1>{name}</h1>
        </div>
        <form
          className="cc-sbv-sp-form"
          onSubmit={(e) => {
            e.preventDefault();
            const text = query.trim();
            if (!text) return;
            setQuery("");
            go(text);
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#8a94a6"
            strokeWidth="2.4"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the web or type an address"
            spellCheck={false}
            autoComplete="off"
          />
        </form>
        {data.servers.length > 0 && (
          <div className="cc-sbv-sp-section">
            <div className="cc-sbv-sp-label">Running in this project</div>
            <div className="cc-sbv-sp-tiles">
              {data.servers.map((server) => (
                <button
                  key={server.port}
                  type="button"
                  className="cc-sbv-sp-tile"
                  title={server.url}
                  onClick={() => go(server.url)}
                >
                  <Badge text={`${server.port}`} colorKey={`${server.port}`} />
                  <b>localhost:{server.port}</b>
                  <small className="cc-sbv-sp-live">{server.label}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {data.recent.length > 0 && (
          <div className="cc-sbv-sp-section">
            <div className="cc-sbv-sp-label">Recent</div>
            <div className="cc-sbv-sp-tiles">
              {data.recent.map((site) => (
                <RecentTile
                  key={site.url}
                  connection={connection}
                  url={site.url}
                  title={site.title}
                  go={go}
                />
              ))}
            </div>
          </div>
        )}
        {onAskAgent && (
          <form
            className="cc-sbv-sp-agent"
            onSubmit={(e) => {
              e.preventDefault();
              const text = task.trim();
              if (!text) return;
              setTask("");
              onAskAgent(text);
              flash("Asking an agent...");
            }}
          >
            <b>Ask an agent</b>
            <input
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g. test the sign-up flow on localhost:5173 and report bugs"
            />
            <button>Start</button>
          </form>
        )}
        <div className="cc-sbv-sp-hints">
          <span>
            {apple ? (
              <>
                <kbd>&#8984;C</kbd> <kbd>&#8984;V</kbd>
              </>
            ) : (
              <>
                <kbd>Ctrl+C</kbd> <kbd>Ctrl+V</kbd>
              </>
            )}{" "}
            copy and paste
          </span>
          <span>Take over and hand back any time</span>
          {canRunOnComputer && (
            <span>Sites that block cloud servers: Runs on my computer</span>
          )}
        </div>
      </div>
    </div>
  );
}
