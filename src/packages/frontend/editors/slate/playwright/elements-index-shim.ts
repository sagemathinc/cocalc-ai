// Minimal re-export of the registry helpers without pulling in elements/types.
export * from "../elements/register";

export function isElementOfType(x: any, type: string | string[]): boolean {
  if (x == null) return false;
  const t = x.type;
  if (Array.isArray(type)) return type.includes(t);
  return t === type;
}
