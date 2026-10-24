import { ErrorCode, HarnessError, type HostEvent, newId } from "@harness/shared";
import type { Context, Hono } from "hono";
import { errorResponse, type Transport } from "../api/routes.ts";
import type { PromptDecision } from "./broker.ts";
import type { PluginManager } from "./manager.ts";

/** Route params are always present for the routes that read them. */
const P = (c: Context, k: string): string => c.req.param(k) as string;

async function body<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  return ((await c.req.json().catch(() => ({}))) ?? {}) as T;
}

export function pluginRoutes(pm: PluginManager) {
  return (app: Hono, _transport: Transport) => {
    const wrap =
      (fn: (c: Context) => Promise<Response> | Response) =>
      async (c: Context) => {
        try {
          return await fn(c);
        } catch (err) {
          return errorResponse(c, err);
        }
      };

    app.get("/api/plugins", wrap((c) => c.json({ plugins: pm.list(), safeMode: pm.safeMode })));
    app.get("/api/catalog", wrap((c) => c.json({ entries: pm.discover() })));
    app.get("/api/grants", wrap((c) => c.json({ grants: pm.repo.allGrants() })));

    app.post(
      "/api/plugins/inspect",
      wrap(async (c) => {
        const b = await body<{ source?: string }>(c);
        if (!b.source) throw new HarnessError(ErrorCode.InvalidParams, "缺少 source");
        return c.json(pm.inspect(b.source));
      }),
    );

    app.post(
      "/api/plugins/install",
      wrap(async (c) => {
        const b = await body<{ source?: string; dev?: boolean; enable?: boolean; grantOptional?: string[] }>(c);
        if (!b.source) throw new HarnessError(ErrorCode.InvalidParams, "缺少 source");
        const plugin = await pm.install(b.source, { dev: b.dev, enable: b.enable, grantOptional: b.grantOptional });
        return c.json({ plugin }, 201);
      }),
    );

    app.get("/api/plugins/:id", wrap(async (c) => c.json({ ...pm.detail(P(c, "id")), secretsConfigured: await pm.secretsConfigured(P(c, "id")) })));

    app.delete(
      "/api/plugins/:id",
      wrap(async (c) => {
        await pm.uninstall(P(c, "id"), { keepData: c.req.query("keepData") === "1" });
        return c.json({ ok: true });
      }),
    );

    app.post("/api/plugins/:id/enable", wrap(async (c) => c.json({ plugin: await pm.enable(P(c, "id")) })));
    app.post("/api/plugins/:id/disable", wrap(async (c) => c.json({ plugin: await pm.disable(P(c, "id")) })));
    app.post(
      "/api/plugins/:id/update",
      wrap(async (c) => {
        const b = await body<{ source?: string; acceptPermissions?: boolean }>(c);
        return c.json(await pm.update(P(c, "id"), { source: b.source, acceptPermissions: b.acceptPermissions }));
      }),
    );
    app.post("/api/plugins/:id/rollback", wrap(async (c) => c.json(await pm.rollback(P(c, "id")))));
    app.post("/api/plugins/:id/restart", wrap(async (c) => c.json({ plugin: await pm.restart(P(c, "id")) })));

    app.put(
      "/api/plugins/:id/settings",
      wrap(async (c) => {
        const b = await body<{ values?: Record<string, unknown> }>(c);
        return c.json({ settings: pm.setSettings(P(c, "id"), b.values ?? {}) });
      }),
    );

    app.put(
      "/api/plugins/:id/secrets/:key",
      wrap(async (c) => {
        const b = await body<{ value?: string }>(c);
        await pm.setSecret(P(c, "id"), P(c, "key"), String(b.value ?? ""));
        return c.json({ ok: true, configured: true });
      }),
    );
    app.delete(
      "/api/plugins/:id/secrets/:key",
      wrap(async (c) => {
        await pm.setSecret(P(c, "id"), P(c, "key"), null);
        return c.json({ ok: true, configured: false });
      }),
    );

    app.post(
      "/api/plugins/:id/grants",
      wrap(async (c) => {
        const b = await body<{ permission?: string; scope?: unknown }>(c);
        if (!b.permission) throw new HarnessError(ErrorCode.InvalidParams, "缺少 permission");
        return c.json(pm.grant(P(c, "id"), b.permission, b.scope));
      }),
    );
    app.delete("/api/plugins/:id/grants/:permission", wrap((c) => c.json(pm.revoke(P(c, "id"), P(c, "permission")))));

    app.get("/api/plugins/:id/logs", wrap((c) => c.json({ lines: pm.logs(P(c, "id"), Number(c.req.query("lines") ?? 200)) })));
    app.get("/api/plugins/:id/trace", wrap((c) => c.json({ entries: pm.traces(P(c, "id")) })));

    /** Calls a plugin tool directly, without the model (developer loop: harness plugin call). */
    app.post(
      "/api/plugins/:id/tools/:name/call",
      wrap(async (c) => {
        const b = await body<{ arguments?: unknown; workspace?: string }>(c);
        const started = Date.now();
        try {
          const output = await pm.callTool(P(c, "id"), P(c, "name"), b.arguments ?? {}, {
            sessionId: "direct",
            turnId: newId("turn"),
            callId: newId("call"),
            workspace: b.workspace ?? pm.daemon.config.workspace ?? null,
            signal: new AbortController().signal,
          });
          return c.json({ ok: true, output, durationMs: Date.now() - started });
        } catch (err) {
          const e = err as { name?: string; payload?: unknown };
          if (e?.name === "ToolFailure") return c.json({ ok: false, output: e.payload, durationMs: Date.now() - started });
          throw err;
        }
      }),
    );

    app.get("/api/commands", wrap((c) => c.json({ commands: pm.commands() })));
    app.post(
      "/api/commands/:name",
      wrap(async (c) => {
        const b = await body<{ args?: string[]; workspace?: string; sessionId?: string }>(c);
        const name = P(c, "name");
        if (!(c.req.header("accept") ?? "").includes("application/x-ndjson"))
          return c.json(await pm.runCommand(name, b.args ?? [], { workspace: b.workspace ?? null, sessionId: b.sessionId }));
        // Streaming variant (CLI): permission and confirmation prompts raised while the
        // command runs are delivered on this response so the caller can answer them.
        const sid = b.sessionId ?? newId("cmd");
        const abort = new AbortController();
        const encoder = new TextEncoder();
        let off: () => void = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (v: unknown) => {
              try {
                controller.enqueue(encoder.encode(`${JSON.stringify(v)}\n`));
              } catch {
                // client went away
              }
            };
            off = pm.daemon.bus.on((e: HostEvent) => {
              if ("sessionId" in e && e.sessionId === sid) send(e);
            });
            pm.runCommand(name, b.args ?? [], { workspace: b.workspace ?? null, sessionId: sid, signal: abort.signal })
              .then((result) => send({ type: "command.result", result }))
              .catch((err) => send({ type: "command.error", error: err instanceof HarnessError ? err.toJSON() : { code: ErrorCode.InternalError, message: (err as Error).message } }))
              .finally(() => {
                off();
                try {
                  controller.close();
                } catch {
                  // already closed
                }
              });
          },
          cancel() {
            off();
            abort.abort();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
      }),
    );

    // ---- UI panels (iframe on the panel origin; requests relayed by the host UI) ----
    app.get("/api/panels", wrap((c) => c.json({ origin: pm.panelOrigin(), panels: pm.panels().map((p) => ({ ...p, url: pm.panelUrl(p.pluginId, p.panelId) })) })));
    app.post(
      "/api/plugins/:id/panels/:panel/call",
      wrap(async (c) => {
        const b = await body<{ method?: string; params?: Record<string, unknown>; workspace?: string | null; confirmed?: boolean }>(c);
        return c.json(await pm.panelCall(P(c, "id"), P(c, "panel"), String(b.method ?? ""), b.params ?? {}, { workspace: b.workspace ?? pm.daemon.config.workspace ?? null, confirmed: b.confirmed === true }));
      }),
    );

    app.post("/api/actions/:id/apply", wrap((c) => c.json({ applied: pm.applyAction(P(c, "id")) })));
    app.post(
      "/api/prompts/:id",
      wrap(async (c) => {
        const b = await body<{ decision?: PromptDecision }>(c);
        const d = b.decision;
        if (d !== "once" && d !== "always" && d !== "deny") throw new HarnessError(ErrorCode.InvalidParams, "decision 只能是 once / always / deny");
        const ok = pm.resolvePrompt(P(c, "id"), d);
        return c.json({ ok }, ok ? 200 : 404);
      }),
    );
  };
}
