import type { ReactNode } from "react";
import { LayoutDashboard, Package, Puzzle, ScrollText, Settings } from "lucide-react";
import clsx from "clsx";
import { usePanelStore, type Tab } from "../store";
import { Dot } from "./Badge";

const NAV: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: "dashboard", label: "Дашборд", icon: <LayoutDashboard size={18} /> },
  { id: "lots", label: "Лоты", icon: <Package size={18} /> },
  { id: "plugins", label: "Плагины", icon: <Puzzle size={18} /> },
  { id: "logs", label: "Журнал", icon: <ScrollText size={18} /> },
  { id: "settings", label: "Настройки", icon: <Settings size={18} /> },
];

export function Layout({ children }: { children: ReactNode }) {
  const tab = usePanelStore((state) => state.tab);
  const setTab = usePanelStore((state) => state.setTab);
  const connection = usePanelStore((state) => state.connection);
  const revision = connection.revision;

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800/80 bg-slate-950/60 px-4 py-6">
        <div className="mb-8 px-2">
          <div className="text-lg font-semibold tracking-tight text-slate-100">Lucrium</div>
          <div className="text-xs text-slate-500">панель управления</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={clsx(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
                tab === item.id
                  ? "bg-indigo-500/15 text-indigo-200"
                  : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            <Dot tone={connection.status} />
            <span className="capitalize">{connection.status}</span>
          </div>
          <div className="mt-1 truncate text-slate-500" title={connection.detail}>
            {connection.detail || "—"}
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={connection.url}>
            {connection.url || "воркер не настроен"}
          </div>
          {revision !== null && <div className="mt-1 text-[10px] text-slate-600">revision {revision}</div>}
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
