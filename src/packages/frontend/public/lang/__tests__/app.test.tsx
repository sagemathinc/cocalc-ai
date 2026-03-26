/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import type { LangMessages } from "../messages";
import PublicLangApp from "../app";
import { getLangRouteFromPath, parsePublicLangTarget } from "../routes";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      addEventListener: jest.fn(),
      addListener: jest.fn(),
      dispatchEvent: jest.fn(),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: jest.fn(),
      removeListener: jest.fn(),
    }),
  });
});

const EN_MESSAGES: LangMessages = {
  "chat-text":
    "<p><strong><A>Chatrooms</A></strong> help teams communicate.</p>",
  "chat-title": "Chat Rooms",
  "home-page": "Home page",
  intro: "What is CoCalc?",
  "intro-1": "<p>CoCalc is collaborative software for technical computing.</p>",
  "jupyter-notebook-text":
    "<p><strong><a>Jupyter</a></strong> collaboration with <A2>teaching</A2> support and <AI>coding agents</AI>.</p>",
  "jupyter-notebook-title": "Jupyter Notebooks",
  "latex-editor-text":
    "<p><strong><a>LaTeX</a></strong> editing with <AI>language model</AI> help.</p>",
  "latex-editor-title": "LaTeX Editor",
  "linux-text":
    "<p><strong><A>Linux terminals</A></strong> and a broader <A2>software stack</A2>.</p>",
  "linux-title": "Linux Terminal",
  "many-languages": "Core workflows",
  "many-languages-text": "Translated marketing content.",
  "realtime-collaboration": "Realtime Collaboration",
  "realtime-collaboration-text":
    "<p>Work together in shared technical documents.</p>",
  "sign-up": "Sign up",
  "site-description": "Collaborative Calculations",
  tagline: "CoCalc: Collaborative Calculations and Data Science",
  "teaching-text":
    "<p><strong><A>Course management</A></strong> for classes.</p>",
  "teaching-title": "Course Management",
};

describe("public/lang routes", () => {
  it("parses both /lang and locale aliases", () => {
    expect(getLangRouteFromPath("/lang")).toEqual({ view: "index" });
    expect(getLangRouteFromPath("/de")).toEqual({
      locale: "de",
      view: "locale",
    });
    expect(getLangRouteFromPath("/lang/de")).toEqual({
      locale: "de",
      view: "locale",
    });
    expect(parsePublicLangTarget("/features")).toBeUndefined();
  });
});

describe("PublicLangApp", () => {
  it("renders the language index", () => {
    render(
      <PublicLangApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Translations for Launchpad" }),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: /Deutsch/ })).not.toBeNull();
  });

  it("renders a translated landing page", () => {
    render(
      <PublicLangApp
        config={{ site_name: "Launchpad" }}
        initialMessages={EN_MESSAGES}
        initialMessagesLocale="en"
        initialRoute={{ locale: "en", view: "locale" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "CoCalc: Collaborative Calculations and Data Science",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "What is CoCalc?" }),
    ).not.toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Sign up" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Jupyter/ })).not.toBeNull();
  });
});
