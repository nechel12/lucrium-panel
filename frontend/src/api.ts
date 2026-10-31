import type { EventHistory, LogsResult, PanelInfo, PluginSchema, SettingsInfo } from "./types";

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ACCESS_KEY = "lucrium_access_token";

function readAccessToken(): string | null {
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const fromHash = hash.get("access");
    if (fromHash) {
      sessionStorage.setItem(ACCESS_KEY, fromHash);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return fromHash;
    }
    return sessionStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

const accessToken = readAccessToken();
let csrfToken: string | null = null;
let sessionPromise: Promise<string> | null = null;

function withAccess(headers: Headers): Headers {
  if (accessToken) headers.set("X-Lucrium-Access", accessToken);
  return headers;
}

/** Получает CSRF-токен и HttpOnly cookie для локального API/WebSocket. */
export async function ensureSession(): Promise<string> {
  if (csrfToken) return csrfToken;
  if (!sessionPromise) {
    const headers = withAccess(new Headers());
    sessionPromise = fetch("/api/session", { credentials: "same-origin", headers })
      .then(async (response) => {
        if (!response.ok) throw new ApiError(`http_${response.status}`, "не удалось открыть сессию панели");
        const body = (await response.json()) as { token?: string };
        if (!body.token) throw new ApiError("invalid_session", "сервер не выдал CSRF-токен");
        csrfToken = body.token;
        return body.token;
      })
      .catch((error) => {
        sessionPromise = null;
        throw error;
      });
  }
  return sessionPromise;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = withAccess(new Headers(init?.headers));
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Lucrium-CSRF", await ensureSession());
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    if (response.status === 403) {
      // Токен мог смениться после перезапуска backend — сбрасываем кэш.
      csrfToken = null;
      sessionPromise = null;
    }
    const body = await response.json().catch(() => null);
    const code = body?.error?.code ?? `http_${response.status}`;
    const message = body?.error?.message ?? body?.detail ?? response.statusText;
    throw new ApiError(String(code), String(message));
  }
  return (await response.json()) as T;
}

export const api = {
  info: () => request<PanelInfo>("/api/state"),
  settings: () => request<SettingsInfo>("/api/settings"),
  saveSettings: (worker_url: string, token: string, verify_tls: boolean, tls_fingerprint = "") =>
    request<SettingsInfo>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ worker_url, token, verify_tls, tls_fingerprint }),
    }),
  disconnect: () => request<{ ok: boolean }>("/api/settings", { method: "DELETE" }),
  command: <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) =>
    request<{ result: T }>("/api/command", {
      method: "POST",
      body: JSON.stringify({ method, params }),
    }).then((body) => body.result),
  logs: (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== "") params.set(key, String(value));
    });
    return request<LogsResult>(`/api/logs?${params.toString()}`);
  },
  eventHistory: (session_id?: string, limit = 100) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (session_id) params.set("session_id", session_id);
    return request<EventHistory>(`/api/events/history?${params.toString()}`);
  },
  addAccount: (body: unknown) =>
    request<{ account_id: string }>("/api/accounts", { method: "POST", body: JSON.stringify(body) }),
  removeAccount: (id: string) => request<{ account_id: string }>(`/api/accounts/${id}`, { method: "DELETE" }),
  startSession: (id: string) => request<unknown>(`/api/accounts/${id}/start`, { method: "POST" }),
  stopSession: (id: string) => request<unknown>(`/api/accounts/${id}/stop`, { method: "POST" }),
  callClient: <T = unknown>(id: string, client_method: string, params: Record<string, unknown> = {}) =>
    request<{ data: T }>(`/api/accounts/${id}/call`, {
      method: "POST",
      body: JSON.stringify({ client_method, params }),
    }).then((body) => body.data),
  installPlugin: (file: File, autoStart: boolean, overwrite: boolean) => {
    const form = new FormData();
    form.set("file", file);
    form.set("auto_start", String(autoStart));
    form.set("overwrite", String(overwrite));
    return request<unknown>("/api/plugins/install", { method: "POST", body: form });
  },
  removePlugin: (id: string, purge: boolean) =>
    request<unknown>(`/api/plugins/${id}?purge_data=${purge}`, { method: "DELETE" }),
  pluginSchema: (id: string) => request<PluginSchema>(`/api/plugins/${id}/schema`),
  setPluginConfig: (id: string, config: Record<string, unknown>) =>
    request<unknown>(`/api/plugins/${id}/config`, {
      method: "POST",
      body: JSON.stringify({ config }),
    }),
  exportState: (passphrase: string) =>
    request<{ filename: string; blob_b64: string; sha256: string; size_bytes: number }>("/api/export", {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    }),
  importState: (blob_b64: string, passphrase: string, mode: "merge" | "replace") =>
    request<{ accounts: number; plugins: number; sessions_started: number }>("/api/import", {
      method: "POST",
      body: JSON.stringify({ blob_b64, passphrase, mode }),
    }),
  rotateToken: () =>
    request<{ token: string; rotated_at: string; persisted?: boolean; warning?: string }>("/api/token/rotate", {
      method: "POST",
    }),
  restart: (scope: "worker" | "sessions", delay_seconds = 0) =>
    request<{ scheduled: boolean; delay_seconds: number }>("/api/restart", {
      method: "POST",
      body: JSON.stringify({ scope, delay_seconds }),
    }),
  updateCheck: () =>
    request<{ current: string; latest: string | null; url: string | null; update_available: boolean; error?: string }>(
      "/api/update-check",
    ),
};
