import { useMemo, useState } from "react";
import type { JsonSchema } from "../types";

interface Props {
  schema: JsonSchema;
  initial: Record<string, unknown>;
  submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}

function defaultFor(prop: JsonSchema): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.type === "boolean") return false;
  if (prop.type === "integer" || prop.type === "number") return prop.minimum ?? 0;
  if (prop.type === "array") return [];
  if (prop.type === "object") return {};
  if (prop.enum?.length) return prop.enum[0];
  return "";
}

function isJsonField(prop: JsonSchema): boolean {
  return prop.type === "object" || (prop.type === "array" && !prop.items?.enum);
}

function parseJsonField(key: string, prop: JsonSchema, value: unknown): unknown {
  if (!isJsonField(prop) || typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return prop.type === "array" ? [] : {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Поле «${prop.title ?? key}» содержит некорректный JSON`);
  }
  if (prop.type === "array" && !Array.isArray(parsed)) {
    throw new Error(`Поле «${prop.title ?? key}» должно быть массивом`);
  }
  if (prop.type === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(`Поле «${prop.title ?? key}» должно быть объектом`);
  }
  return parsed;
}

function buildInitial(schema: JsonSchema, initial: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  Object.entries(schema.properties ?? {}).forEach(([key, prop]) => {
    values[key] = initial[key] !== undefined ? initial[key] : defaultFor(prop);
  });
  return values;
}

const fieldClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-indigo-500";

export function SchemaForm({ schema, initial, onSubmit, submitLabel = "Сохранить" }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() => buildInitial(schema, initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const required = useMemo(() => new Set(schema.required ?? []), [schema.required]);

  const setValue = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const prepared: Record<string, unknown> = { ...values };
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        prepared[key] = parseJsonField(key, prop, prepared[key]);
      }
      await onSubmit(prepared);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const entries = Object.entries(schema.properties ?? {});
  if (!entries.length) {
    return <p className="text-sm text-slate-400">У плагина нет настроек.</p>;
  }

  return (
    <div className="space-y-4">
      {schema.description && <p className="text-xs text-slate-400">{schema.description}</p>}
      {entries.map(([key, prop]) => {
        const label = prop.title ?? key;
        const value = values[key];
        const isRequired = required.has(key);
        return (
          <div key={key} className="space-y-1.5">
            {prop.type !== "boolean" && (
              <label className="flex items-center gap-1 text-xs font-medium text-slate-300">
                {label}
                {isRequired && <span className="text-rose-400">*</span>}
              </label>
            )}
            {prop.description && <p className="text-[11px] leading-relaxed text-slate-500">{prop.description}</p>}
            {prop.type === "boolean" ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(event) => setValue(key, event.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-indigo-500"
                />
                {label}
              </label>
            ) : prop.enum ? (
              <select value={String(value ?? "")} onChange={(event) => setValue(key, event.target.value)} className={fieldClass}>
                {!isRequired && <option value="">—</option>}
                {prop.enum.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : prop.type === "array" && prop.items?.enum ? (
              <div className="flex flex-wrap gap-2">
                {prop.items.enum.map((option) => {
                  const selected = Array.isArray(value) ? (value as string[]) : [];
                  const active = selected.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() =>
                        setValue(
                          key,
                          active ? selected.filter((item) => item !== option) : [...selected, option],
                        )
                      }
                      className={
                        active
                          ? "rounded-full border border-indigo-500/50 bg-indigo-500/15 px-3 py-1 text-xs text-indigo-200"
                          : "rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:border-slate-500"
                      }
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            ) : prop.type === "integer" || prop.type === "number" ? (
              <input
                type="number"
                value={Number(value ?? 0)}
                min={prop.minimum}
                max={prop.maximum}
                step={prop.type === "integer" ? 1 : "any"}
                onChange={(event) => setValue(key, event.target.value === "" ? "" : Number(event.target.value))}
                className={fieldClass}
              />
            ) : isJsonField(prop) ? (
              <textarea
                rows={3}
                value={typeof value === "string" ? value : JSON.stringify(value ?? (prop.type === "array" ? [] : {}), null, 2)}
                onChange={(event) => setValue(key, event.target.value)}
                className={`${fieldClass} font-mono text-xs`}
              />
            ) : prop.maxLength && prop.maxLength > 200 ? (
              <textarea
                rows={3}
                value={String(value ?? "")}
                maxLength={prop.maxLength}
                onChange={(event) => setValue(key, event.target.value)}
                className={fieldClass}
              />
            ) : (
              <input
                type={/secret|token|key|password/i.test(key) ? "password" : "text"}
                value={String(value ?? "")}
                maxLength={prop.maxLength}
                onChange={(event) => setValue(key, event.target.value)}
                className={fieldClass}
              />
            )}
          </div>
        );
      })}
      {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50"
      >
        {busy ? "Сохраняем…" : submitLabel}
      </button>
    </div>
  );
}
