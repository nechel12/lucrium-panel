import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ensureSession } from "./api";
import { usePanelStore } from "./store";
import { Layout } from "./components/Layout";
import Setup from "./screens/Setup";
import Dashboard from "./screens/Dashboard";
import Lots from "./screens/Lots";
import Plugins from "./screens/Plugins";
import Logs from "./screens/Logs";
import Settings from "./screens/Settings";

function useLiveEvents() {
  const apply = usePanelStore((state) => state.apply);
  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = async () => {
      try {
        await ensureSession();
      } catch {
        if (!closed) timer = window.setTimeout(() => void connect(), 2000);
        return;
      }
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/api/events`);
      socket.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data));
        } catch {
          /* ignore malformed */
        }
      };
      socket.onclose = () => {
        if (!closed) timer = window.setTimeout(() => void connect(), 2000);
      };
    };
    void connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, [apply]);
}

export default function App() {
  useLiveEvents();
  const tab = usePanelStore((state) => state.tab);
  const apply = usePanelStore((state) => state.apply);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const fallback = useQuery({
    queryKey: ["state"],
    queryFn: api.info,
    refetchInterval: 10_000,
    enabled: Boolean(settings.data?.configured),
  });

  useEffect(() => {
    if (fallback.data) apply({ kind: "snapshot", data: fallback.data });
  }, [fallback.data, apply]);

  if (settings.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">Загрузка Lucrium…</div>
    );
  }
  if (settings.isError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-200">
          Не удалось загрузить настройки панели: {(settings.error as Error).message}
        </div>
      </div>
    );
  }
  if (!settings.data?.configured) return <Setup />;

  return (
    <Layout>
      {tab === "dashboard" && <Dashboard />}
      {tab === "lots" && <Lots />}
      {tab === "plugins" && <Plugins />}
      {tab === "logs" && <Logs />}
      {tab === "settings" && <Settings />}
    </Layout>
  );
}
