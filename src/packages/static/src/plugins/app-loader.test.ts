import {
  PUBLIC_BODY_PLACEHOLDER,
  PUBLIC_HEAD_PLACEHOLDER,
} from "@cocalc/util/public-site-metadata";
import { renderAppTemplate } from "./app-template";

test("renders the shared public head placeholder into the app template", () => {
  const html = renderAppTemplate("app");
  expect(html.split(PUBLIC_HEAD_PLACEHOLDER)).toHaveLength(2);
  expect(html.split(PUBLIC_BODY_PLACEHOLDER)).toHaveLength(2);
  expect(html).toContain('data-cocalc-entry="app"');
  expect(html).not.toContain("cocalc-public-head-placeholder");
  expect(html).not.toContain("cocalc-public-body-placeholder -->");
  expect(html).not.toContain("cocalc-entry-placeholder");
});

test("identifies each generated shell independently", () => {
  expect(renderAppTemplate("public-viewer")).toContain(
    'data-cocalc-entry="public-viewer"',
  );
});

test("renders the independent ultralite shell", () => {
  const html = renderAppTemplate("ultralite");
  expect(html).toContain('id="cocalc-ultralite-root"');
  expect(html).toContain('data-cocalc-entry="ultralite"');
  expect(html).toContain("Opening CoCalc");
  expect(html).not.toContain("Opening the essential CoCalc workspace");
  expect(html).not.toContain("cocalc-public-head-placeholder");
});
