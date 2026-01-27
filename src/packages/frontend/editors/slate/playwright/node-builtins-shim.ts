export const sep = "/";
export const delimiter = ":";

export const join = (...parts: string[]) =>
  parts.filter((part) => part && part.length > 0).join("/");

export const dirname = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
export const basename = (p: string) => p.split("/").pop() || "";

export default {};

