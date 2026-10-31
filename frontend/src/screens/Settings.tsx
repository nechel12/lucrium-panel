import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, KeyRound, LogOut, RefreshCw, Upload } from "lucide-react";
import { api } from "../api";

function downloadBase64(filename: string, blobBase64: string) {
  const binary = atob(blobBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

const card = "rounded-2xl border border-slate-800 bg-slate-900/50 p-5";
const field = "w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const button = "rounded-lg bg-indigo-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50";
const ghost = "rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 transition hover:border-slate-500";

export default function Settings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [verifyTls, setVerifyTls] = useState(true);
  const [fingerprint, setFingerprint] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settings.data) {
      setUrl(settings.data.worker_url);
      setVerifyTls(settings.data.verify_tls);
      setFingerprint(settings.data.tls_fingerprint ?? "");
    }
  }, [settings.data]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({ queryKey: ["state"] });
    } catch (exc) {
      setMessage(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const saveConnection = () =>
    run(async () => {
      await api.saveSettings(url, token, verifyTls, fingerprint);
      setToken("");
      setMessage("Подключение сохранено.");
    });

  // Backend отказывается сохранять verify_tls=false без fingerprint — не даём
  // отправить заведомо небезопасную конфигурацию и здесь.
  const needsFingerprint = !verifyTls && fingerprint.trim() === "";

  const rotate = () =>
    run(async () => {
      if (!confirm("Старый токен будет отозван. Продолжить?")) return;
      const result = await api.rotateToken();
      setNewToken(result.token);
      if (result.warning) setMessage(result.warning);
    });

  const exportState = () =>
    run(async () => {
      if (passphrase !== passphraseConfirm) throw new Error("Пароли экспорта не совпадают");
      const result = await api.exportState(passphrase);
      downloadBase64(result.filename, result.blob_b64);
      setMessage(`Экспортировано: ${result.filename} (${Math.round(result.size_bytes / 1024)} КБ).`);
    });

  const importState = () =>
    run(async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) throw new Error("Выберите файл .lcs");
      if (mode === "replace" && !confirm("Режим «заменить» удалит все текущие аккаунты, плагины и историю. Продолжить?")) {
        return;
      }
      const blob = await fileToBase64(file);
      const result = await api.importState(blob, importPassphrase, mode);
      setMessage(`Импортировано: аккаунтов ${result.accounts}, плагинов ${result.plugins}.`);
    });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Настройки</h1>
        <p className="mt-1 text-sm text-slate-400">Подключение, безопасность и резервные копии.</p>
      </header>

      {message && <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-xs text-slate-300">{message}</div>}

      <section className={card}>
        <h2 className="text-sm font-semibold">Подключение</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1.5 text-xs text-slate-400">
            Адрес воркера
            <input value={url} onChange={(event) => setUrl(event.target.value)} className={field} />
          </label>
          <label className="space-y-1.5 text-xs text-slate-400">
            Новый токен {settings.data?.token_hint && <span className="text-slate-600">(текущий {settings.data.token_hint})</span>}
            <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="оставьте пустым, чтобы не менять" type="password" className={`${field} font-mono`} />
          </label>
        </div>
        <label className="mt-3 block space-y-1.5 text-xs text-slate-400">
          Fingerprint сертификата{needsFingerprint && <span className="text-amber-300"> (обязательно)</span>}
          <input
            value={fingerprint}
            onChange={(event) => setFingerprint(event.target.value)}
            placeholder="SHA256 fingerprint из install.sh (для self-signed)"
            className={`${field} font-mono text-xs`}
          />
        </label>
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={verifyTls} onChange={(event) => setVerifyTls(event.target.checked)} className="h-4 w-4 accent-indigo-500" />
          Проверять TLS-сертификат (CA)
        </label>
        {!verifyTls && (
          <p className="mt-2 text-[11px] text-amber-300">
            Без проверки сертификата злоумышленник в вашей сети перехватит pairing-токен и логины маркетплейсов —
            поэтому при отключённой проверке обязателен fingerprint выше.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={() => void saveConnection()} disabled={busy || needsFingerprint} className={button}>
            Сохранить
          </button>
          <button
            onClick={() =>
              void run(async () => {
                if (!confirm("Отключиться и забыть токен?")) return;
                await api.disconnect();
                setMessage("Панель отключена от воркера.");
              })
            }
            disabled={busy}
            className={ghost}
          >
            <span className="inline-flex items-center gap-2">
              <LogOut size={13} /> Отключиться
            </span>
          </button>
        </div>
      </section>

      <section className={card}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound size={15} /> Pairing-токен
        </h2>
        <p className="mt-1 text-xs text-slate-500">Ротация отзывает старый токен; новый показывается один раз.</p>
        <button onClick={() => void rotate()} disabled={busy} className={`${button} mt-4`}>
          Сгенерировать новый токен
        </button>
        {newToken && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <code className="flex-1 break-all font-mono text-xs text-amber-200">{newToken}</code>
            <button
              title="Скопировать"
              onClick={() => void navigator.clipboard?.writeText(newToken).catch(() => undefined)}
              className="rounded p-1 text-amber-300 hover:bg-amber-500/10"
            >
              <Copy size={14} />
            </button>
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Download size={15} /> Экспорт состояния
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Аккаунты с кредами, прокси, плагины и их конфиги — в один зашифрованный файл.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="пароль (мин. 8 символов)" type="password" className={`${field} max-w-xs`} />
          <input value={passphraseConfirm} onChange={(event) => setPassphraseConfirm(event.target.value)} placeholder="повторите пароль" type="password" className={`${field} max-w-xs`} />
          <button
            onClick={() => void exportState()}
            disabled={busy || passphrase.length < 8 || passphrase !== passphraseConfirm}
            className={button}
          >
            Скачать .lcs
          </button>
        </div>
      </section>

      <section className={card}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Upload size={15} /> Импорт состояния
        </h2>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".lcs" className="text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:text-slate-200" />
          <input value={importPassphrase} onChange={(event) => setImportPassphrase(event.target.value)} placeholder="пароль файла" type="password" className={`${field} max-w-xs`} />
          <select value={mode} onChange={(event) => setMode(event.target.value as "merge" | "replace")} className={`${field} max-w-[160px]`}>
            <option value="merge">дополнить</option>
            <option value="replace">заменить</option>
          </select>
          <button onClick={() => void importState()} disabled={busy || importPassphrase.length < 8} className={button}>
            Импортировать
          </button>
        </div>
      </section>

      <section className={card}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <RefreshCw size={15} /> Обслуживание
        </h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() =>
              void run(async () => {
                await api.restart("sessions");
                setMessage("Сессии перезапускаются.");
              })
            }
            disabled={busy}
            className={ghost}
          >
            Перезапустить сессии
          </button>
          <button
            onClick={() =>
              void run(async () => {
                if (!confirm("Перезапустить воркер? Панель отключится на несколько секунд.")) return;
                await api.restart("worker", 0);
                setMessage("Воркер перезапускается…");
              })
            }
            disabled={busy}
            className={ghost}
          >
            Перезапустить воркер
          </button>
        </div>
      </section>

      <UpdateSection />
    </div>
  );
}

function UpdateSection() {
  const update = useQuery({ queryKey: ["update-check"], queryFn: api.updateCheck, staleTime: 3_600_000, retry: 0 });
  return (
    <section className={card}>
      <h2 className="text-sm font-semibold">Версия панели</h2>
      <p className="mt-1 text-xs text-slate-500">
        Текущая: <span className="font-mono text-slate-300">{update.data?.current ?? "…"}</span>
        {update.data?.latest && <> · последняя: <span className="font-mono text-slate-300">{update.data.latest}</span></>}
      </p>
      {update.data?.update_available && update.data.url && (
        <a href={update.data.url} target="_blank" rel="noreferrer" className={`${button} mt-3 inline-block`}>
          Скачать обновление
        </a>
      )}
      {update.data?.error && <p className="mt-2 text-[11px] text-slate-600">Проверка недоступна: {update.data.error}</p>}
    </section>
  );
}
