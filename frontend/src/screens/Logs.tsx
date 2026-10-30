import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { usePanelStore } from "../store";
import type { LogEntry, LogsResult } from "../types";

const LEVEL_TONE: Record<LogEntry["level"], string> = {
  debug: "neutral",
  info: "info",
  warning: "warning",
  error: "error",
};

export default function Logs() {
  const plugins = usePanelStore((store) => store.state?.plugins ?? []);
  const [scope, setScope] = useState<"worker" | "plugin">("worker");
  const [pluginId, setPluginId] = useState("");
  const [level, setLevel] = useState("");

  const logs = useQuery<LogsResult>({
    queryKey: ["logs", scope, pluginId, level],
    queryFn: () =>
      api.logs({
        scope,
        plugin_id: scope === "plugin" ? pluginId : undefined,
        level: level || undefined,
        limit: 200,
      }),
    enabled: scope !== "plugin" || Boolean(pluginId),
    refetchInterval: 3000,
  });

  const field = "rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Журнал</h1>
        <p className="mt-1 text-sm text-slate-400">Логи воркера и плагинов с курсорной пагинацией.</p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <select value={scope} onChange={(event) => setScope(event.target.value as "worker" | "plugin")} className={field}>
          <option value="worker">воркер</option>
          <option value="plugin">плагин</option>
        </select>
        {scope === "plugin" && (
          <select value={pluginId} onChange={(event) => setPluginId(event.target.value)} className={field}>
            <option value="">— выберите плагин —</option>
            {plugins.map((plugin) => (
              <option key={plugin.id} value={plugin.id}>
                {plugin.name}
              </option>
            ))}
          </select>
        )}
        <select value={level} onChange={(event) => setLevel(event.target.value)} className={field}>
          <option value="">все уровни</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
        <button onClick={() => void logs.refetch()} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500">
          Обновить
        </button>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
        <div className="max-h-[65vh] overflow-auto">
          {scope === "plugin" && !pluginId && (
            <div className="px-5 py-8 text-center text-sm text-slate-500">Выберите плагин, чтобы увидеть его журнал.</div>
          )}
          {logs.isLoading && <div className="px-5 py-8 text-center text-sm text-slate-500">Загрузка…</div>}
          {logs.isError && <div className="px-5 py-8 text-center text-sm text-rose-300">{(logs.error as Error).message}</div>}
          {logs.data?.entries.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-500">Записей нет.</div>}
          <table className="w-full text-xs">
            <tbody>
              {logs.data?.entries.map((entry) => (
                <tr key={entry.seq} className="border-b border-slate-800/60 last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-[10px] text-slate-600">
                    {new Date(entry.ts).toLocaleTimeString("ru-RU")}
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={LEVEL_TONE[entry.level]}>{entry.level}</Badge>
                  </td>
                  <td className="px-2 py-2 font-mono text-[10px] text-slate-500">{entry.source}</td>
                  <td className="px-2 py-2 text-slate-300">{entry.message}</td>
                  <td className="max-w-xs truncate px-4 py-2 font-mono text-[10px] text-slate-600" title={JSON.stringify(entry.fields)}>
                    {Object.keys(entry.fields).length ? JSON.stringify(entry.fields) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
