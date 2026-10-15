import { is_https_or_loopback_url, site_settings_conf } from "./site-defaults";

describe("sagebrush_origin", () => {
  const conf = site_settings_conf.sagebrush_origin;
  const valid = conf.valid as (val: string) => boolean;

  test("is off unless a site turns it on", () => {
    // Showing a board sends the file to this origin, so a site must choose
    // it; cocalc.ai sets https://sagebrush.space in its site settings.
    expect(conf.default).toBe("");
    expect(valid("")).toBe(true);
  });

  test("must be https, or http on this computer", () => {
    expect(valid("https://sagebrush.space")).toBe(true);
    expect(valid(" https://dev.sagebrush.space ")).toBe(true);
    expect(valid("http://localhost:8907")).toBe(true);
    expect(valid("http://127.0.0.1:8907")).toBe(true);
    expect(valid("http://[::1]:8907")).toBe(true);
    expect(valid("http://sagebrush.space")).toBe(false);
    expect(valid("http://localhost.example.com")).toBe(false);
    expect(valid("ftp://sagebrush.space")).toBe(false);
    expect(valid("javascript:alert(1)")).toBe(false);
    expect(valid("not a url")).toBe(false);
    expect(is_https_or_loopback_url("")).toBe(false);
  });
});
