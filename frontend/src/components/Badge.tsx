import type { ReactNode } from "react";
import clsx from "clsx";

const tones: Record<string, string> = {
  running: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  connected: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  stopped: "border-slate-600/40 bg-slate-700/20 text-slate-400",
  disconnected: "border-slate-600/40 bg-slate-700/20 text-slate-400",
  starting: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  connecting: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  restarting: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  error: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  crashed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  neutral: "border-slate-600/40 bg-slate-700/20 text-slate-300",
};

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone] ?? tones.neutral,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: string }) {
  const color =
    tone === "connected" || tone === "running"
      ? "bg-emerald-400"
      : tone === "error" || tone === "crashed"
        ? "bg-rose-400"
        : tone === "connecting" || tone === "starting"
          ? "bg-amber-400"
          : "bg-slate-500";
  return <span className={clsx("h-2 w-2 rounded-full", color)} />;
}
