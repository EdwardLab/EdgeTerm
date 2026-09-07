import { BackupProviderError } from "./base.js";

export async function resolveAccessToken(tokenProvider) {
  const value = typeof tokenProvider === "function" ? await tokenProvider() : tokenProvider;
  const token = typeof value === "string" ? value : value?.accessToken || value?.access_token;
  if (!token) {
    throw new BackupProviderError("provider_auth_required", "Reconnect this storage provider to continue", {
      status: 401,
      recoverable: true,
    });
  }
  return token;
}

export async function oauthFetch(tokenProvider, url, options = {}) {
  const token = await resolveAccessToken(tokenProvider);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    throw new BackupProviderError("provider_auth_expired", "Storage access expired. Reconnect and resume this job.", {
      status: 401,
      recoverable: true,
    });
  }
  if (response.status === 429) {
    throw new BackupProviderError("provider_rate_limited", "The storage provider asked EdgeTerm to slow down", {
      status: 429,
      recoverable: true,
    });
  }
  return response;
}

export async function responseJson(response, code) {
  if (response.ok) return await response.json();
  let details = "";
  try {
    const value = await response.json();
    details = value?.error?.message || value?.error_summary || value?.message || "";
  } catch {}
  throw new BackupProviderError(code, details || `Storage provider request failed with status ${response.status}`, {
    status: response.status,
    recoverable: response.status >= 500 || response.status === 408 || response.status === 409,
  });
}
