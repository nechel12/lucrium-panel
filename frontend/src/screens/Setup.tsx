import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Server, ShieldCheck } from "lucide-react";
import { api } from "../api";

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/nechel12/lucrium-worker/main/install.sh | bash";

export default function Setup() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [verifyTls, setVerifyTls] = useState(true);
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveSettings(url, token, verifyTls, fingerprint);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
            <ShieldCheck size={26} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Подключение к воркеру</h1>
          <p className="mt-2 text-sm text-slate-400">
            Введите адрес VPS и pairing-токен, который напечатал <code className="text-slate-300">install.sh</code>.
          </p>
        </div>

        <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <div className="mb-1.5 text-[11px] font-medium text-slate-400">Если воркер ещё не установлен:</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-slate-950/80 px-2.5 py-2 font-mono text-[10px] text-slate-300">
              {INSTALL_COMMAND}
            </code>
            <button
              type="button"
              title="Скопировать команду"
              onClick={() => {
                void navigator.clipboard?.writeText(INSTALL_COMMAND).catch(() => undefined);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-lg border border-slate-700 p-2 text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
            >
              <Copy size={14} />
            </button>
          </div>
          {copied && <div className="mt-1 text-[10px] text-emerald-400">Скопировано</div>}
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <Server size={14} /> Адрес воркера
            </label>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="203.0.113.10:8443"
              required
              className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm outline-none transition placeholder:text-slate-600 focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500">Без схемы подставится wss://. Для ws:// укажите схему явно.</p>
          </div>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <KeyRound size={14} /> Pairing-токен
            </label>
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="64 hex-символа"
              required
              type="password"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 font-mono text-sm outline-none transition placeholder:text-slate-600 focus:border-indigo-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Fingerprint сертификата (необязательно)</label>
            <input
              value={fingerprint}
              onChange={(event) => setFingerprint(event.target.value)}
              placeholder="SHA256 fingerprint из вывода install.sh"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 font-mono text-xs outline-none transition placeholder:text-slate-600 focus:border-indigo-500"
            />
            <p className="text-[11px] text-slate-500">
              Для самоподписанного сертификата укажите fingerprint — соединение будет защищено от MITM без отключения проверки.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={verifyTls}
              onChange={(event) => setVerifyTls(event.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-indigo-500"
            />
            Проверять TLS-сертификат (CA). Для self-signed используйте fingerprint выше.
          </label>
          {error && (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50"
          >
            {busy ? "Подключаемся…" : "Подключиться"}
          </button>
        </form>
        <p className="mt-4 text-center text-[11px] text-slate-600">
          Токен хранится только на этом компьютере (0600) и не попадает в браузер.
        </p>
      </div>
    </div>
  );
}
