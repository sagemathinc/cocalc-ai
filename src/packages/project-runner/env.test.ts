import { normalizeProjectContainerConatServer } from "./run/env";

describe("normalizeProjectContainerConatServer", () => {
  it("rewrites localhost to the podman host alias", () => {
    expect(normalizeProjectContainerConatServer("http://localhost:9102")).toBe(
      "http://host.containers.internal:9102",
    );
  });

  it("rewrites 127.0.0.1 to the podman host alias", () => {
    expect(normalizeProjectContainerConatServer("http://127.0.0.1:9102")).toBe(
      "http://host.containers.internal:9102",
    );
  });

  it("leaves non-loopback conat hosts unchanged", () => {
    expect(
      normalizeProjectContainerConatServer("http://router.internal:9102"),
    ).toBe("http://router.internal:9102");
  });
});
