import { KeyRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { JsonSchema } from "../lib/api.ts";
import { Badge, Button, Input, Select, Switch } from "./ui.tsx";

type Field = JsonSchema & { "x-secret"?: boolean };

const typeOf = (f: Field): string => {
  if (f.enum) return "enum";
  const t = Array.isArray(f.type) ? f.type.find((x) => x !== "null") : f.type;
  return t ?? "string";
};

function coerce(f: Field, raw: string): unknown {
  const t = typeOf(f);
  if (t === "integer") return raw === "" ? undefined : Number.parseInt(raw, 10);
  if (t === "number") return raw === "" ? undefined : Number(raw);
  if (t === "array") return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return raw;
}

/**
 * Settings form generated from the plugin's configSchema. Supports string, number,
 * integer, boolean, enum and string arrays; `x-secret` fields are stored in the
 * macOS Keychain through a separate endpoint and are never displayed again.
 */
export function SchemaForm({
  schema,
  values,
  secretsConfigured,
  onSave,
  onSaveSecret,
  saving,
  errors,
}: {
  schema: JsonSchema;
  values: Record<string, unknown>;
  secretsConfigured: Record<string, boolean>;
  onSave(values: Record<string, unknown>): void;
  onSaveSecret(key: string, value: string | null): void;
  saving?: boolean;
  errors?: Array<{ path?: string; message: string }>;
}) {
  const props = schema.properties ?? {};
  const entries = useMemo(() => Object.entries(props) as Array<[string, Field]>, [props]);
  const plain = entries.filter(([, f]) => !f["x-secret"]);
  const secrets = entries.filter(([, f]) => f["x-secret"]);
  const [draft, setDraft] = useState<Record<string, unknown>>(values);
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft(values), [values]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(values);
  const errFor = (k: string) => errors?.find((e) => e.path === `/${k}` || e.path?.startsWith(`/${k}/`))?.message;

  if (!entries.length) return <div className="text-[12.5px] text-muted">这个插件没有可配置的选项。</div>;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      {plain.length > 0 && (
        <div className="space-y-4">
          {plain.map(([key, f]) => {
            const t = typeOf(f);
            const v = draft[key] ?? f.default;
            const id = `cfg-${key}`;
            const label = (
              <label htmlFor={id} className="block text-[13px] font-medium">
                {f.title ?? key}
                {schema.required?.includes(key) && <span className="text-danger"> *</span>}
              </label>
            );
            return (
              <div key={key} className="grid grid-cols-[minmax(160px,240px)_1fr] items-start gap-4" data-field={key}>
                <div>
                  {label}
                  <div className="mt-0.5 font-mono text-[11px] text-muted">{key}</div>
                </div>
                <div>
                  {t === "boolean" ? (
                    <Switch id={id} checked={v === true} onCheckedChange={(c) => setDraft({ ...draft, [key]: c })} />
                  ) : t === "enum" ? (
                    <Select id={id} value={String(v ?? "")} onChange={(e) => setDraft({ ...draft, [key]: f.enum?.find((x) => String(x) === e.target.value) })}>
                      {(f.enum ?? []).map((x) => (
                        <option key={String(x)} value={String(x)}>
                          {String(x)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      type={t === "integer" || t === "number" ? "number" : "text"}
                      min={f.minimum}
                      max={f.maximum}
                      value={Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v)}
                      placeholder={f.default !== undefined ? `默认：${String(f.default)}` : undefined}
                      onChange={(e) => setDraft({ ...draft, [key]: coerce(f, e.target.value) })}
                      className="max-w-[360px]"
                    />
                  )}
                  {f.description && <div className="mt-1 text-[12px] text-muted">{f.description}</div>}
                  {(f.minimum !== undefined || f.maximum !== undefined) && (
                    <div className="mt-1 text-[11.5px] text-muted">
                      范围 {f.minimum ?? "−∞"} – {f.maximum ?? "∞"}
                    </div>
                  )}
                  {errFor(key) && <div className="mt-1 text-[12px] text-danger">{errFor(key)}</div>}
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" variant="primary" disabled={!dirty || saving}>
              {saving ? "正在保存…" : "保存设置"}
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(values)}>
                放弃修改
              </Button>
            )}
          </div>
        </div>
      )}

      {secrets.length > 0 && (
        <div className="space-y-3 rounded-[10px] border border-border bg-bg-subtle p-3">
          <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <KeyRound className="size-3.5" /> 密钥保存在 macOS 钥匙串中；插件进程拿不到明文，只能让宿主代为附加到已授权的请求上。
          </div>
          {secrets.map(([key, f]) => (
            <div key={key} className="grid grid-cols-[minmax(160px,240px)_1fr] items-center gap-4" data-secret={key}>
              <div>
                <div className="text-[13px] font-medium">{f.title ?? key}</div>
                <div className="font-mono text-[11px] text-muted">{key}</div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={secretsConfigured[key] ? "已设置（输入新值以替换）" : "未设置"}
                  value={secretDraft[key] ?? ""}
                  onChange={(e) => setSecretDraft({ ...secretDraft, [key]: e.target.value })}
                  className="max-w-[300px]"
                />
                <Button
                  size="sm"
                  disabled={!secretDraft[key]}
                  onClick={() => {
                    onSaveSecret(key, secretDraft[key] ?? "");
                    setSecretDraft({ ...secretDraft, [key]: "" });
                  }}
                >
                  保存
                </Button>
                {secretsConfigured[key] ? (
                  <>
                    <Badge tone="success">已设置</Badge>
                    <Button size="sm" variant="danger-ghost" onClick={() => onSaveSecret(key, null)}>
                      清除
                    </Button>
                  </>
                ) : (
                  <Badge tone="warning">未设置</Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
