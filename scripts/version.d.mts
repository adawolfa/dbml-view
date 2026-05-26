/** Strict semver (X.Y.Z) — safe for Tauri / MSI / Cargo. */
export function semver(): string;
/** Display version — may include a `-dev.N+gSHA` suffix for untagged builds. */
export function version(): string;
