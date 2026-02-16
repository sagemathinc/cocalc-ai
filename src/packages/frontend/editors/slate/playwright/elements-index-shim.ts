// Ensure registrations run in the harness, then re-export registry helpers.
import "./elements-types-shim";

export * from "../elements/register";
export { isElementOfType } from "./elements-types-shim";
