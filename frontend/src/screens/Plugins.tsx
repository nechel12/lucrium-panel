import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Settings2, Trash2, Upload } from "lucide-react";
import { api } from "../api";
import { Badge, Dot } from "../components/Badge";
import { Modal } from "../components/Modal";
import { SchemaForm } from "../components/SchemaForm";
import { usePanelStore } from "../store";
import type { PluginState } from "../types";

export default function Plugins() {
  const plugins = usePanelStore((store) => store.state?.plugins ?? []);
  const queryClient = useQueryClient();
  const [configPlugin, setConfigPlugin] = useState<PluginState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [autoStart, setAutoStart] = useState(true);
  const [overwrite, setOverwrite] = useState(false);

  const install = async () => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.installPlugin(file, autoStart, overwrite);
      setMessage(`Плагин «${file.name}» установлен.`);
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    } catch (exc) {
      setMessage(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plugin: PluginState) => {
    if (!confirm(`Удалить плагин «${plugin.name}»?`)) return;
    try {
      await api.removePlugin(plugin.id, false);
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    } catch (exc) {
      setMessage(exc instanceof Error ? exc.message : String(exc));
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Плагины</h1>
        <p className="mt-1 text-sm text-slate-400">
          Установка zip-архивом; форма настроек рендерится из JSON-схемы манифеста.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <h2 className="text-sm font-semibold">Установить плагин</h2>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <input
            type="file"
            accept=".zip"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:text-slate-200 hover:file:bg-slate-700"
          />
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} className="h-4 w-4 accent-indigo-500" />
            запустить сразу
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} className="h-4 w-4 accent-indigo-500" />
            перезаписать
          </label>
          <button
            onClick={install}
            disabled={!file || busy}
            className="flex items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50"
          >
            <Upload size={14} /> {busy ? "Устанавливаем…" : "Установить"}
          </button>
        </div>
        {message && <p className="mt-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">{message}</p>}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/50">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="text-sm font-semibold">Установленные</h2>
          <p className="text-xs text-slate-500">Плагины исполняются в отдельных процессах</p>
        </div>
        {plugins.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">Плагинов пока нет.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3">Плагин</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3">Версия</th>
                <th className="px-5 py-3">Рестарты</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {plugins.map((plugin) => (
                <tr key={plugin.id} className="border-t border-slate-800/70">
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-100">{plugin.name}</div>
                    <div className="font-mono text-[10px] text-slate-500">{plugin.id}</div>
                    {plugin.last_error && (
                      <div className="mt-0.5 max-w-md truncate text-[10px] text-rose-400" title={plugin.last_error}>
                        {plugin.last_error}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={plugin.status}>
                      <Dot tone={plugin.status} />
                      {plugin.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-slate-300">{plugin.version}</td>
                  <td className="px-5 py-3 text-slate-400">{plugin.restarts}</td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      {plugin.has_config_schema && (
                        <button
                          title="Настроить"
                          onClick={() => setConfigPlugin(plugin)}
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
                        >
                          <Settings2 size={14} />
                        </button>
                      )}
                      <button
                        title="Удалить"
                        onClick={() => void remove(plugin)}
                        className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {configPlugin && <ConfigModal plugin={configPlugin} onClose={() => setConfigPlugin(null)} />}
    </div>
  );
}

function ConfigModal({ plugin, onClose }: { plugin: PluginState; onClose: () => void }) {
  const queryClient = useQueryClient();
  const schema = useQuery({ queryKey: ["plugin-schema", plugin.id], queryFn: () => api.pluginSchema(plugin.id) });
  const [json, setJson] = useState(() => JSON.stringify(plugin.config, null, 2));
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: Record<string, unknown>) => {
    await api.setPluginConfig(plugin.id, values);
    await queryClient.invalidateQueries({ queryKey: ["state"] });
    onClose();
  };

  const submitJson = async () => {
    setError(null);
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      await submit(parsed);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  };

  return (
    <Modal title={`Настройки · ${plugin.name}`} onClose={onClose}>
      {schema.isLoading && <p className="text-sm text-slate-400">Загружаем схему…</p>}
      {schema.isError && <p className="text-sm text-rose-300">{(schema.error as Error).message}</p>}
      {schema.data &&
        (schema.data.config_schema ? (
          <SchemaForm schema={schema.data.config_schema} initial={schema.data.config} onSubmit={submit} />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">У плагина нет JSON-схемы — введите конфиг вручную.</p>
            <textarea
              rows={10}
              value={json}
              onChange={(event) => setJson(event.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/70 p-3 font-mono text-xs outline-none focus:border-indigo-500"
            />
            {error && <p className="text-xs text-rose-300">{error}</p>}
            <button onClick={() => void submitJson()} className="w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400">
              Сохранить
            </button>
          </div>
        ))}
      <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-500">
        <Download size={12} /> Воркер перезапустит плагин с новым конфигом.
      </div>
    </Modal>
  );
}
