export type Platform = "funpay" | "playerok" | "ggsel";

export type SessionStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export type PluginStatus =
  | "installed"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "restarting";

export interface ProxyConfig {
  scheme: "http" | "https" | "socks4" | "socks5";
  host: string;
  port: number;
  username?: string | null;
}

export interface AccountState {
  id: string;
  platform: Platform;
  label: string;
  status: SessionStatus;
  capabilities: string[];
  proxy?: ProxyConfig | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
  last_event_at?: string | null;
  restarts: number;
}

export interface PluginState {
  id: string;
  name: string;
  version: string;
  api: string;
  source: "local" | "remote";
  enabled: boolean;
  status: PluginStatus;
  restarts: number;
  last_error?: string | null;
  has_config_schema: boolean;
  config: Record<string, unknown>;
  installed_at: string;
  updated_at: string;
}

export interface StatusCounts {
  total: number;
  running: number;
  error: number;
}

export interface WorkerStatus {
  version: string;
  protocol: string;
  started_at: string;
  uptime_seconds: number;
  python: string;
  os: string;
  sessions: StatusCounts;
  plugins: StatusCounts;
  connected_panels: number;
}

export interface StateSnapshot {
  revision: number;
  generated_at: string;
  status: WorkerStatus;
  accounts: AccountState[];
  plugins: PluginState[];
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface PanelInfo {
  status: ConnectionStatus;
  detail: string;
  url: string;
  revision: number | null;
  worker: WorkerStatus | null;
  state: StateSnapshot | null;
}

export interface SettingsInfo {
  worker_url: string;
  configured: boolean;
  token_hint: string;
  verify_tls: boolean;
  tls_fingerprint: string;
}

export interface LiveEvent {
  kind: "event";
  event: string;
  data: unknown;
}

export interface EventHistory {
  events: Array<{
    platform: string;
    session_id: string;
    kind: string;
    payload: unknown;
    ts: string;
  }>;
  next_cursor: number | null;
}

export interface LogEntry {
  seq: number;
  ts: string;
  level: "debug" | "info" | "warning" | "error";
  source: string;
  message: string;
  fields: Record<string, unknown>;
}

export interface LogsResult {
  entries: LogEntry[];
  next_cursor: number | null;
}

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  items?: JsonSchema;
  format?: string;
}

export interface PluginSchema {
  plugin_id: string;
  config_schema: JsonSchema | null;
  config: Record<string, unknown>;
}
