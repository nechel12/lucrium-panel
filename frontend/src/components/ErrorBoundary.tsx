import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Что именно защищаем (экран, модалка) — попадает в текст отката. */
  label?: string;
}

interface State {
  error: string | null;
}

/**
 * Плагины отдают панели недоверенные JSON-схемы и конфиги, поэтому одна ошибка
 * рендера не должна превращать весь интерфейс в белый экран без подсказки.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Детали не проглатываем: стек должен оставаться в консоли для разбора.
    console.error(`[panel] ошибка рендера (${this.props.label ?? "экран"}):`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="flex h-full min-h-[240px] items-center justify-center p-4">
        <div className="w-full max-w-md space-y-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-200">
          <h2 className="font-semibold">
            {this.props.label ? `${this.props.label}: интерфейс упал` : "Интерфейс упал"}
          </h2>
          <p className="text-xs leading-relaxed text-rose-300">
            Причина — ошибка рендера, чаще всего из-за некорректной схемы плагина. Перезагрузка безопасна: данные
            воркера не меняются.
          </p>
          <p className="break-words rounded-lg bg-slate-950/60 px-3 py-2 font-mono text-[11px] text-slate-300">
            {this.state.error}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 transition hover:border-slate-500"
            >
              Повторить
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-400"
            >
              Перезагрузить
            </button>
          </div>
        </div>
      </div>
    );
  }
}
