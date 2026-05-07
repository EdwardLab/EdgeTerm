export const CLOUD_ENABLED = Boolean(globalThis.EDGETERM_CLOUD_ENABLED ?? __EDGETERM_CLOUD_ENABLED__);
export const PAGE_KIND = String(globalThis.EDGETERM_PAGE_KIND || "main");
export const ASSET_BASE = String(globalThis.EDGETERM_ASSET_BASE || "./");

export function assetUrl(path) {
  const base = ASSET_BASE.endsWith("/") ? ASSET_BASE : `${ASSET_BASE}/`;
  return new URL(path.replace(/^\/+/, ""), base.startsWith("http") ? base : new URL(base, globalThis.location.href)).toString();
}
