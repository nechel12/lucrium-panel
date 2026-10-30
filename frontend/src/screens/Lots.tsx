import { useEffect, useState } from "react";
import { Package, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { usePanelStore } from "../store";
import type { AccountState, Platform } from "../types";

interface Row {
  id: string;
  title: string;
  price: number | null;
  status: string;
  raw: Record<string, unknown>;
}

const LOADERS: Record<Platform, { method: string; params: (subcategory: string) => Record<string, unknown> }> = {
  funpay: { method: "lots.list_self", params: (subcategory) => ({ subcategory_id: Number(subcategory) }) },
  playerok: { method: "items.list_self", params: () => ({ limit: 50 }) },
  ggsel: { method: "products.my", params: () => ({ limit: 100 }) },
};

const NOTES: Record<Platform, string> = {
  funpay: "FunPay: укажите subcategory_id — список лотов привязан к подкатегории. Цена меняется через поля лота (v1.5).",
  playerok: "PlayerOK: items.list_self; можно менять цену, публиковать и удалять.",
  ggsel: "GGsel: products.my; можно менять цену (update_price).",
};

function toRows(data: unknown): Row[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const price =
        typeof item.price === "number"
          ? item.price
          : typeof item.sale_price === "number"
            ? item.sale_price
            : null;
      const status = String(
        item.status ??
          (item.visible === false || item.active === false
            ? "hidden"
            : item.active === true || item.visible === true
              ? "active"
              : "—"),
      );
      return {
        id: String(item.id ?? ""),
        title: String(item.name ?? item.title_ru ?? item.description ?? item.id ?? ""),
        price,
        status,
        raw: item,
      };
    });
}

export default function Lots() {
  const accounts = usePanelStore((store) => store.state?.accounts ?? []).filter(
    (account) => account.status === "running",
  );
  const [accountId, setAccountId] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account: AccountState | undefined = accounts.find((item) => item.id === accountId) ?? accounts[0];

  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts[0].id);
  }, [accountId, accounts]);

  useEffect(() => {
    setRows([]);
    setEdits({});
    setError(null);
  }, [accountId]);

  const load = async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      const loader = LOADERS[account.platform];
      if (account.platform === "funpay" && !subcategory.trim()) {
        throw new Error("Укажите subcategory_id для FunPay");
      }
      const data = await api.callClient<unknown>(account.id, loader.method, loader.params(subcategory));
      setRows(toRows(data));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setLoading(false);
    }
  };

  const updatePrice = async (row: Row) => {
    if (!account) return;
    const price = Number(edits[row.id] ?? row.price ?? 0);
    if (!Number.isFinite(price) || price < 0) {
      setError("Некорректная цена");
      return;
    }
    setError(null);
    try {
      if (account.platform === "playerok") {
        await api.callClient(account.id, "items.update", { item_id: row.id, price });
      } else if (account.platform === "ggsel") {
        await api.callClient(account.id, "products.update_price", { product_id: Number(row.id), price });
      } else {
        throw new Error("Редактирование цены FunPay появится в v1.5 (lots.fields + lots.save)");
      }
      await load();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  };

  const remove = async (row: Row) => {
    if (!account) return;
    if (!confirm(`Удалить «${row.title || row.id}»?`)) return;
    setError(null);
    try {
      if (account.platform === "funpay") {
        await api.callClient(account.id, "lots.delete", { lot_id: Number(row.id) });
      } else if (account.platform === "playerok") {
        await api.callClient(account.id, "items.remove", { item_id: row.id });
      } else {
        throw new Error("У GGsel нет удаления товара в текущем API");
      }
      await load();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  };

  const publish = async (row: Row) => {
    if (!account) return;
    try {
      await api.callClient(account.id, "items.publish", { item_id: row.id });
      await load();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  };

  const field = "rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Лоты и товары</h1>
        <p className="mt-1 text-sm text-slate-400">
          Чтение и базовое управление через клиент aiosellers выбранной сессии.
        </p>
      </header>

      {accounts.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 px-5 py-10 text-center text-sm text-slate-500">
          Нет запущенных сессий — запустите аккаунт на дашборде.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <select value={account?.id ?? ""} onChange={(event) => setAccountId(event.target.value)} className={field}>
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.platform}
                </option>
              ))}
            </select>
            {account?.platform === "funpay" && (
              <input
                value={subcategory}
                onChange={(event) => setSubcategory(event.target.value)}
                placeholder="subcategory_id"
                className={field}
              />
            )}
            <button
              onClick={() => void load()}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> {loading ? "Загружаем…" : "Загрузить"}
            </button>
            <span className="text-[11px] text-slate-500">{account ? NOTES[account.platform] : ""}</span>
          </div>

          {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}

          <section className="rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-2 border-b border-slate-800 px-5 py-4 text-sm font-semibold">
              <Package size={16} /> {rows.length} позиций
            </div>
            {rows.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-slate-500">Нажмите «Загрузить», чтобы получить список.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Позиция</th>
                    <th className="px-5 py-3">Цена</th>
                    <th className="px-5 py-3">Статус</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t border-slate-800/70">
                      <td className="px-5 py-3">
                        <div className="font-medium text-slate-100">{row.title || row.id}</div>
                        <div className="font-mono text-[10px] text-slate-500">{row.id}</div>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <input
                            value={edits[row.id] ?? (row.price ?? "").toString()}
                            onChange={(event) => setEdits({ ...edits, [row.id]: event.target.value })}
                            className={`${field} w-24`}
                          />
                          <button onClick={() => void updatePrice(row)} className="rounded-lg border border-slate-700 px-2 py-1.5 text-[11px] text-slate-300 hover:border-slate-500">
                            Сохранить
                          </button>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={row.status === "active" ? "running" : row.status === "hidden" ? "stopped" : "neutral"}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end gap-1">
                          {account?.platform === "playerok" && (
                            <button onClick={() => void publish(row)} className="rounded-lg px-2 py-1.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200">
                              Опубликовать
                            </button>
                          )}
                          <button onClick={() => void remove(row)} className="rounded-lg p-2 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300">
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
        </>
      )}
    </div>
  );
}
