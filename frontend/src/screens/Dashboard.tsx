import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Boxes, Play, Plus, RefreshCw, Square, Trash2, Users } from "lucide-react";
import { api } from "../api";
import { Badge, Dot } from "../components/Badge";
import { Modal } from "../components/Modal";
import { usePanelStore, type EventItem } from "../store";
import type { AccountState, Platform } from "../types";

const PLATFORM_LABEL: Record<Platform, string> = {
  funpay: "FunPay",
  playerok: "PlayerOK",
  ggsel: "GGsel",
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} д ${hours} ч`;
  if (hours) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function eventSummary(item: { event: string; data: unknown }): string {
  const data = item.data as Record<string, unknown> | null;
  if (item.event === "event" && data) {
    const platform = String(data.platform ?? "");
    const kind = String(data.kind ?? "");
    const session = String(data.session_id ?? "");
    return `${PLATFORM_LABEL[platform as Platform] ?? platform} · ${kind} · ${session}`;
  }
  if (item.event === "plugin_log" && data) return `${String(data.source)}: ${String(data.message)}`;
  if (item.event === "plugin_error" && data) return `${String(data.plugin_id)}: ${String(data.error)}`;
  if (item.event === "command_result" && data) return `${String(data.method)}: ${data.ok ? "ok" : "error"}`;
  return item.event;
}

export default function Dashboard() {
  const state = usePanelStore((store) => store.state);
  const liveStatus = usePanelStore((store) => store.workerStatus);
  const connection = usePanelStore((store) => store.connection);
  const events = usePanelStore((store) => store.events);
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState("");
  const [history, setHistory] = useState<EventItem[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);

  const status = liveStatus ?? state?.status;
  const accounts = state?.accounts ?? [];
  const visibleEvents = events.filter((item) => {
    if (!sessionFilter) return true;
    const data = item.data as Record<string, unknown> | null;
    return data?.session_id === sessionFilter;
  });
  const feed = [...history, ...visibleEvents]
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
    .slice(0, 100);

  const loadHistory = async () => {
    setHistoryBusy(true);
    try {
      const result = await api.eventHistory(sessionFilter || undefined);
      setHistory(
        result.events.map((event, index) => ({
          id: -index - 1,
          kind: "event" as const,
          event: "event",
          data: event,
          at: event.ts,
        })),
      );
    } catch (exc) {
      alert(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setHistoryBusy(false);
    }
  };

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    } catch (exc) {
      alert(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Дашборд</h1>
          <p className="mt-1 text-sm text-slate-400">
            {connection.status === "connected"
              ? `Воркер ${status?.version ?? ""} · протокол ${status?.protocol ?? ""}`
              : connection.detail}
          </p>
        </div>
        <Badge tone={connection.status}>
          <Dot tone={connection.status} />
          {connection.status === "connected" ? "на связи" : connection.status}
        </Badge>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={<Users size={16} />} label="Сессии" value={`${status?.sessions.running ?? 0} / ${status?.sessions.total ?? 0}`} hint={`${status?.sessions.error ?? 0} с ошибкой`} />
        <StatCard icon={<Boxes size={16} />} label="Плагины" value={`${status?.plugins.running ?? 0} / ${status?.plugins.total ?? 0}`} hint={`${status?.plugins.error ?? 0} с ошибкой`} />
        <StatCard icon={<Activity size={16} />} label="Uptime" value={formatUptime(status?.uptime_seconds ?? 0)} hint={status?.os ?? ""} />
        <StatCard icon={<RefreshCw size={16} />} label="Панелей" value={String(status?.connected_panels ?? 0)} hint={`revision ${state?.revision ?? 0}`} />
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/50">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Аккаунты</h2>
            <p className="text-xs text-slate-500">Сессии площадок на воркере</p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-indigo-400"
          >
            <Plus size={14} /> Добавить аккаунт
          </button>
        </div>
        {accounts.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            Пока нет аккаунтов. Добавьте первый — воркер сразу поднимет сессию.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3">Аккаунт</th>
                <th className="px-5 py-3">Платформа</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3">Возможности</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  busy={busyId === account.id}
                  onStart={() => run(account.id, () => api.startSession(account.id))}
                  onStop={() => run(account.id, () => api.stopSession(account.id))}
                  onRemove={() => {
                    if (confirm(`Удалить аккаунт «${account.label}»?`)) {
                      void run(account.id, () => api.removeAccount(account.id));
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Живые события</h2>
            <p className="text-xs text-slate-500">Лента per-аккаунт из HubEvent и журнал плагинов</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sessionFilter}
              onChange={(event) => {
                setSessionFilter(event.target.value);
                setHistory([]);
              }}
              className="rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500"
            >
              <option value="">все аккаунты</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => void loadHistory()}
              disabled={historyBusy}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 disabled:opacity-50"
            >
              {historyBusy ? "Загружаем…" : "История"}
            </button>
          </div>
        </div>
        <div className="max-h-72 divide-y divide-slate-800/70 overflow-auto">
          {feed.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-500">Событий пока нет.</div>}
          {feed.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-xs">
              <div className="flex items-center gap-3">
                <Badge tone={item.event === "plugin_error" ? "error" : item.event === "event" ? "info" : "neutral"}>
                  {item.event}
                </Badge>
                <span className="text-slate-300">{eventSummary(item)}</span>
              </div>
              <span className="shrink-0 font-mono text-[10px] text-slate-600">
                {new Date(item.at).toLocaleTimeString("ru-RU")}
              </span>
            </div>
          ))}
        </div>
      </section>

      {showAdd && (
        <AddAccountModal
          onClose={() => setShowAdd(false)}
          onCreated={async () => {
            setShowAdd(false);
            await queryClient.invalidateQueries({ queryKey: ["state"] });
          }}
        />
      )}
    </div>
  );
}

function StatCard({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold tracking-tight">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-slate-500">{hint || "—"}</div>
    </div>
  );
}

function AccountRow({
  account,
  busy,
  onStart,
  onStop,
  onRemove,
}: {
  account: AccountState;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const running = account.status === "running";
  return (
    <tr className="border-t border-slate-800/70">
      <td className="px-5 py-3">
        <div className="font-medium text-slate-100">{account.label}</div>
        <div className="font-mono text-[10px] text-slate-500">{account.id}</div>
        {account.last_error && <div className="mt-0.5 max-w-xs truncate text-[10px] text-rose-400" title={account.last_error}>{account.last_error}</div>}
      </td>
      <td className="px-5 py-3 text-slate-300">{PLATFORM_LABEL[account.platform]}</td>
      <td className="px-5 py-3">
        <Badge tone={account.status}>
          <Dot tone={account.status} />
          {account.status}
        </Badge>
      </td>
      <td className="px-5 py-3 text-[11px] text-slate-500">{account.capabilities.join(", ") || "—"}</td>
      <td className="px-5 py-3">
        <div className="flex justify-end gap-1">
          {running ? (
            <IconButton title="Остановить" onClick={onStop} disabled={busy}>
              <Square size={14} />
            </IconButton>
          ) : (
            <IconButton title="Запустить" onClick={onStart} disabled={busy}>
              <Play size={14} />
            </IconButton>
          )}
          <IconButton title="Удалить" onClick={onRemove} disabled={busy} danger>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={
        danger
          ? "rounded-lg p-2 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40"
          : "rounded-lg p-2 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
      }
    >
      {children}
    </button>
  );
}

function AddAccountModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [platform, setPlatform] = useState<Platform>("funpay");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [sellerId, setSellerId] = useState("");
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxy, setProxy] = useState({ scheme: "http", host: "", port: "1080", username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const credentials =
        platform === "funpay"
          ? { platform, golden_key: secret }
          : platform === "playerok"
            ? { platform, access_token: secret }
            : { platform, api_key: secret, seller_id: sellerId };
      const body: Record<string, unknown> = { platform, label, credentials };
      if (proxyEnabled) {
        body.proxy = {
          scheme: proxy.scheme,
          host: proxy.host,
          port: Number(proxy.port),
          ...(proxy.username ? { username: proxy.username } : {}),
          ...(proxy.password ? { password: proxy.password } : {}),
        };
      }
      await api.addAccount(body);
      await onCreated();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm outline-none focus:border-indigo-500";
  return (
    <Modal title="Новый аккаунт" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-300">Площадка</label>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(PLATFORM_LABEL) as Platform[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setPlatform(item)}
                className={
                  platform === item
                    ? "rounded-lg border border-indigo-500/50 bg-indigo-500/15 px-3 py-2 text-xs text-indigo-200"
                    : "rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400 hover:border-slate-500"
                }
              >
                {PLATFORM_LABEL[item]}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-300">Название</label>
          <input value={label} onChange={(event) => setLabel(event.target.value)} required placeholder="Основной магазин" className={field} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-300">
            {platform === "funpay" ? "golden_key" : platform === "playerok" ? "access_token" : "api_key"}
          </label>
          <input
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
            type="password"
            className={`${field} font-mono`}
          />
        </div>
        {platform === "ggsel" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">seller_id</label>
            <input value={sellerId} onChange={(event) => setSellerId(event.target.value)} required className={field} />
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={proxyEnabled}
            onChange={(event) => setProxyEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-indigo-500"
          />
          Использовать прокси
        </label>
        {proxyEnabled && (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 p-3">
            <select value={proxy.scheme} onChange={(event) => setProxy({ ...proxy, scheme: event.target.value })} className={field}>
              {["http", "https", "socks4", "socks5"].map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <input value={proxy.port} onChange={(event) => setProxy({ ...proxy, port: event.target.value })} placeholder="порт" className={field} />
            <input value={proxy.host} onChange={(event) => setProxy({ ...proxy, host: event.target.value })} placeholder="host" className={`${field} col-span-2`} />
            <input value={proxy.username} onChange={(event) => setProxy({ ...proxy, username: event.target.value })} placeholder="логин (опционально)" className={field} />
            <input value={proxy.password} onChange={(event) => setProxy({ ...proxy, password: event.target.value })} placeholder="пароль" type="password" className={field} />
          </div>
        )}
        {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50"
        >
          {busy ? "Добавляем…" : "Добавить"}
        </button>
      </form>
    </Modal>
  );
}
