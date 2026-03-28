import { inferAppBasePath } from "./app-base-path";

describe("inferAppBasePath", () => {
  it("uses the prefix before /static when booting from a static asset URL", () => {
    expect(inferAppBasePath("/base/static/app.js")).toBe("/base");
    expect(inferAppBasePath("/static/app.js")).toBe("/");
  });

  it("infers a subpath from refreshed app routes", () => {
    expect(inferAppBasePath("/projects")).toBe("/");
    expect(inferAppBasePath("/lang")).toBe("/");
    expect(inferAppBasePath("/redeem/ABC12345")).toBe("/");
    expect(inferAppBasePath("/base/lang/de")).toBe("/base");
    expect(inferAppBasePath("/base/redeem/ABC12345")).toBe("/base");
    expect(inferAppBasePath("/de")).toBe("/");
    expect(inferAppBasePath("/base/de")).toBe("/base");
    expect(
      inferAppBasePath(
        "/base/projects/00000000-1000-4000-8000-000000000000/files",
      ),
    ).toBe("/base");
    expect(inferAppBasePath("/base/projects")).toBe("/base");
    expect(inferAppBasePath("/base/auth/sign-in")).toBe("/base");
    expect(inferAppBasePath("/base/settings/profile")).toBe("/base");
    expect(inferAppBasePath("/base/ssh")).toBe("/base");
    expect(
      inferAppBasePath(
        "/base/projects/00000000-1000-4000-8000-000000000000/apps",
      ),
    ).toBe("/base");
    expect(
      inferAppBasePath(
        "/base/projects/00000000-1000-4000-8000-000000000000/project-home",
      ),
    ).toBe("/base");
  });

  it("keeps the route itself when refreshing the app root under a base path", () => {
    expect(inferAppBasePath("/base")).toBe("/base");
    expect(inferAppBasePath("/")).toBe("/");
  });
});
