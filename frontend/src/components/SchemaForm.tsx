import { useMemo, useState } from "react";
import type { JsonSchema } from "../types";

interface Props {
  schema: JsonSchema;
  initial: Record<string, unknown>;
  submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}

// Схема настроек приходит из манифеста плагина — данные недоверенные, поэтому
// тип каждого узла проверяем в рантайме, а не верим аннотациям TypeScript.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNode(value: unknown): JsonSchema | null {
  return isObject(value) ? (value as JsonSchema) : null;
}

function schemaFields(schema: unknown): Array<[string, JsonSchema]> {
  const properties = asNode(schema)?.properties;
  if (!isObject(properties)) return [];
  const fields: Array<[string, JsonSchema]> = [];
  for (const [key, value] of Object.entries<unknown>(properties)) {
    const node = asNode(value);
    if (node) fields.push([key, node]);
  }
  return fields;
}

// null — enum нет; [] — enum есть, но значений нет либо они неприменимы.
function enumValues(node?: unknown): string[] | null {
  const value = asNode(node)?.enum;
  if (value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    .map((item) => String(item));
}

// title/description тоже из манифеста: в JSX должны попадать только примитивы.
function textOf(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

// Имя поля — лишь эвристика плагина: credential/auth/apikey раньше рендерились
// текстом. Секретом считаем и format:"password" из схемы, и совпадение по имени.
const SECRET_NAME = /secret|token|key|password|passphrase|credential|auth/i;

function isSecretField(key: string, prop: JsonSchema): boolean {
  return prop.format === "password" || SECRET_NAME.test(key);
}

function defaultFor(prop: JsonSchema): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.type === "boolean") return false;
  if (prop.type === "integer" || prop.type === "number") return prop.minimum ?? 0;
  if (prop.type === "array") return [];
  if (prop.type === "object") return {};
  const options = enumValues(prop);
  if (options?.length) return options[0];
  return "";
}

function isJsonField(prop: JsonSchema): boolean {
  return prop.type === "object" || (prop.type === "array" && !prop.items?.enum);
}

function parseJsonField(key: string, prop: JsonSchema, value: unknown): unknown {
  if (!isJsonField(prop) || typeof value !== "string") return value;
  const label = textOf(prop.title) ?? key;
  const text = value.trim();
  if (!text) return prop.type === "array" ? [] : {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Поле «${label}» содержит некорректный JSON`);
  }
  if (prop.type === "array" && !Array.isArray(parsed)) {
    throw new Error(`Поле «${label}» должно быть массивом`);
  }
  if (prop.type === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(`Поле «${label}» должно быть объектом`);
  }
  return parsed;
}

function buildInitial(schema: JsonSchema, initial: Record<string, unknown>): Record<string, unknown> {
  const incoming = isObject(initial) ? initial : {};
  const values: Record<string, unknown> = {};
  schemaFields(schema).forEach(([key, prop]) => {
    values[key] = incoming[key] !== undefined ? incoming[key] : defaultFor(prop);
  });
  return values;
}

const fieldClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-indigo-500";

export function SchemaForm({ schema, initial, onSubmit, submitLabel = "Сохранить" }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() => buildInitial(schema, initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const required = useMemo(() => new Set(Array.isArray(schema?.required) ? schema.required : []), [schema]);

  const setValue = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const prepared: Record<string, unknown> = { ...values };
      for (const [key, prop] of schemaFields(schema)) {
        prepared[key] = parseJsonField(key, prop, prepared[key]);
      }
      await onSubmit(prepared);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const entries = schemaFields(schema);
  const properties = schema?.properties;
  const note = textOf(schema?.description);
  if (!entries.length) {
    const declared = isObject(properties) ? Object.keys(properties).length : properties ? 1 : 0;
    return (
      <p className="text-sm text-slate-400">
        {declared ? "Схема настроек плагина некорректна — поля не распознаны." : "У плагина нет настроек."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {note && <p className="text-xs text-slate-400">{note}</p>}
      {entries.map(([key, prop]) => {
        const label = textOf(prop.title) ?? key;
        const hint = textOf(prop.description);
        const value = values[key];
        const isRequired = required.has(key);
        const options = enumValues(prop);
        const itemOptions = prop.type === "array" ? enumValues(prop.items) : null;
        const numberValue = Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0;
        // enum в недоверенной схеме может быть не списком или состоять из
        // объектов: показываем подсказку вместо падающего select.
        const brokenEnum = (options !== null && options.length === 0) || (itemOptions !== null && itemOptions.length === 0);
        return (
          <div key={key} className="space-y-1.5">
            {prop.type !== "boolean" && (
              <label className="flex items-center gap-1 text-xs font-medium text-slate-300">
                {label}
                {isRequired && <span className="text-rose-400">*</span>}
              </label>
            )}
            {hint && <p className="text-[11px] leading-relaxed text-slate-500">{hint}</p>}
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
            ) : brokenEnum ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                Поле «{label}»: enum в схеме плагина некорректен, значение через форму не задаётся.
              </p>
            ) : options ? (
              <select value={String(value ?? "")} onChange={(event) => setValue(key, event.target.value)} className={fieldClass}>
                {!isRequired && <option value="">—</option>}
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : itemOptions ? (
              <div className="flex flex-wrap gap-2">
                {itemOptions.map((option) => {
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
                value={numberValue}
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
            ) : isSecretField(key, prop) ? (
              <input
                type="password"
                autoComplete="off"
                value={String(value ?? "")}
                maxLength={prop.maxLength}
                onChange={(event) => setValue(key, event.target.value)}
                className={fieldClass}
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
                type="text"
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
