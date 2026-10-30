import type { LogsResult, PanelInfo, PluginSchema, SettingsInfo } from "./types";

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
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
  saveSettings: (worker_url: string, token: string, verify_tls: boolean) =>
    request<SettingsInfo>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ worker_url, token, verify_tls }),
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
  rotateToken: () => request<{ token: string; rotated_at: string }>("/api/token/rotate", { method: "POST" }),
  restart: (scope: "worker" | "sessions", delay_seconds = 0) =>
    request<{ scheduled: boolean; delay_seconds: number }>("/api/restart", {
      method: "POST",
      body: JSON.stringify({ scope, delay_seconds }),
    }),
};
