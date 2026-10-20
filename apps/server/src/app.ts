import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  CHAIN_IDS,
  ChainIdSchema,
  type CsvKind,
  isValidAddress,
  isValidTx,
  normalizeAddress,
  normalizeTx,
  type RunParams,
  RunParamsSchema,
  SeedSchema,
  toCsv,
} from "@fot/core";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { chainHealth } from "./config.ts";
import { ApiError, DEFAULT_EXPAND_DEPTH, type RunManager } from "./runs.ts";
import type { Runtime } from "./runtime.ts";

const KEEPALIVE_MS = 15_000;
const DEFAULT_WEB_DIST = resolve(import.meta.dir, "../../web/dist");

const SeedInputSchema = z.object({
  id: SeedSchema.shape.id.optional(),
  kind: z.enum(["tx", "address"]),
  value: z.string().trim().min(1),
});

/** A live-run request: `RunParams` with optional seed ids; seed values are checked per chain. */
export const LiveRunRequestSchema = RunParamsSchema.omit({ seeds: true })
  .extend({ seeds: z.array(SeedInputSchema).min(1).max(20) })
  .transform((body, ctx): RunParams => {
    const seeds = body.seeds.map((s, i) => {
      const valid =
        s.kind === "tx" ? isValidTx(body.chain, s.value) : isValidAddress(body.chain, s.value);
      if (!valid) {
        ctx.addIssue({
          code: "custom",
          path: ["seeds", i, "value"],
          message: `not a valid ${body.chain} ${s.kind === "tx" ? "transaction hash" : "address"}`,
        });
      }
      return {
        id: s.id ?? `s${i + 1}`,
        kind: s.kind,
        value:
          s.kind === "tx"
            ? normalizeTx(body.chain, s.value)
            : normalizeAddress(body.chain, s.value),
      };
    });
    if (new Set(seeds.map((s) => s.id)).size !== seeds.length) {
      ctx.addIssue({ code: "custom", path: ["seeds"], message: "seed ids must be unique" });
    }
    return { ...body, seeds };
  });

const DemoRequestSchema = z.strictObject({ demo: z.string().min(1) });

/** Either `{demo}` or live run parameters; issues point at the branch the body was aiming for. */
const RunRequestSchema = z.unknown().transform((raw, ctx): { demo: string } | RunParams => {
  const schema =
    typeof raw === "object" && raw !== null && "demo" in raw
      ? DemoRequestSchema
      : LiveRunRequestSchema;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
  return z.NEVER;
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).optional(),
  chain: ChainIdSchema.optional(),
  status: z
    .enum(["running", "completed", "cancelled", "timed_out", "failed", "interrupted"])
    .optional(),
});

const PatchSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
});

const ExpandSchema = z.object({
  edgeId: z.string().min(1),
  maxDepth: z.number().int().min(1).max(50).default(DEFAULT_EXPAND_DEPTH),
});

const CsvKindSchema = z.enum(["edges", "convergences", "exposure", "touchpoints"]);

export interface AppDeps {
  runtime: Runtime;
  manager: RunManager;
  /** Built web app; defaults to `apps/web/dist`. Skipped quietly when absent. */
  webDir?: string | null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function issuesMessage(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(body)"}: ${i.message}`)
    .join("; ");
}

/** zValidator hook: validation failures become the standard JSON error envelope. */
const onInvalid = (
  result: {
    success: boolean;
    error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
  },
  c: Context,
) => {
  if (!result.success && result.error) {
    return c.json(
      { error: { code: "invalid_request", message: issuesMessage(result.error) } },
      400,
    );
  }
};

export function createApp({ runtime, manager, webDir }: AppDeps): Hono {
  const app = new Hono();
  const webRoot = webDir === null ? null : resolve(webDir ?? DEFAULT_WEB_DIST);

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: "invalid_request", message: err.message } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: "internal_error", message: "Internal server error." } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  const badRequest = (message: string) => new ApiError(400, "invalid_request", message);

  app.get("/api/health", (c) =>
    c.json({
      version: pkg.version,
      chains: chainHealth(runtime.config),
      demoOnly: runtime.config.demoOnly,
      ofacFetchedAt: runtime.ofacFetchedAt,
      labelsVersion: runtime.labels.labelsVersion,
    }),
  );

  app.get("/api/demo", (c) =>
    c.json(
      manager.demos().map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        chain: s.chain,
        direction: s.direction,
      })),
    ),
  );

  app.post("/api/runs", zValidator("json", RunRequestSchema, onInvalid), async (c) => {
    const body = c.req.valid("json");
    return c.json(
      await manager.start("demo" in body ? { demo: body.demo } : { params: body }),
      201,
    );
  });

  app.get("/api/runs", (c) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw badRequest(issuesMessage(parsed.error));
    return c.json(manager.list(parsed.data));
  });

  app.get("/api/runs/:id", (c) => {
    const run = manager.get(c.req.param("id"));
    if (!run) throw new ApiError(404, "not_found", "Unknown run.");
    return c.json(run);
  });

  app.get("/api/runs/:id/events", (c) => {
    const id = c.req.param("id");
    if (!manager.has(id)) throw new ApiError(404, "not_found", "Unknown run.");
    return streamSSE(c, async (stream) => {
      const queue: { event: string; data: string }[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let aborted = false;
      const unsubscribe = manager.subscribe(id, (event) => {
        // Serialize now: the live edge objects keep mutating after this call.
        queue.push({ event: event.type, data: JSON.stringify(event) });
        if (event.type === "done") ended = true;
        wake?.();
      });
      stream.onAbort(() => {
        aborted = true;
        wake?.();
      });
      try {
        while (!aborted) {
          for (let m = queue.shift(); m; m = queue.shift()) await stream.writeSSE(m);
          if (ended) break;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = await Promise.race([
            new Promise<false>((resolveWake) => {
              wake = () => resolveWake(false);
            }),
            new Promise<true>((resolveTimer) => {
              timer = setTimeout(() => resolveTimer(true), KEEPALIVE_MS);
            }),
          ]);
          clearTimeout(timer);
          wake = null;
          if (timedOut && queue.length === 0 && !aborted) await stream.write(": keepalive\n\n");
        }
      } finally {
        unsubscribe?.();
      }
    });
  });

  app.post("/api/runs/:id/pause", (c) => c.json(manager.pause(c.req.param("id"))));
  app.post("/api/runs/:id/resume", (c) => c.json(manager.resume(c.req.param("id"))));
  app.post("/api/runs/:id/cancel", (c) => c.json(manager.cancel(c.req.param("id"))));

  app.post("/api/runs/:id/expand", zValidator("json", ExpandSchema, onInvalid), async (c) => {
    const { edgeId, maxDepth } = c.req.valid("json");
    return c.json(await manager.expand(c.req.param("id"), edgeId, { maxDepth }), 202);
  });

  app.patch("/api/runs/:id", zValidator("json", PatchSchema, onInvalid), (c) => {
    const { title, notes } = c.req.valid("json");
    const updated = manager.patch(c.req.param("id"), {
      ...(title !== undefined ? { title } : {}),
      ...(notes !== undefined ? { notes } : {}),
    });
    if (!updated) throw new ApiError(404, "not_found", "Unknown run.");
    return c.json(updated);
  });

  app.delete("/api/runs/:id", (c) => {
    const id = c.req.param("id");
    if (!manager.has(id)) throw new ApiError(404, "not_found", "Unknown run.");
    if (manager.isActive(id))
      throw new ApiError(409, "run_active", "The run is still in progress.");
    manager.remove(id);
    return c.json({ deleted: true });
  });

  const finishedResult = (id: string) => {
    if (!manager.has(id)) throw new ApiError(404, "not_found", "Unknown run.");
    const result = manager.result(id);
    if (!result) throw new ApiError(409, "not_finished", "The run has no result yet.");
    return result;
  };

  app.get("/api/runs/:id/export.json", (c) => {
    const id = c.req.param("id");
    const result = finishedResult(id);
    c.header("Content-Disposition", `attachment; filename="fot-${id}.json"`);
    return c.json(result);
  });

  app.get("/api/runs/:id/export.csv", (c) => {
    const id = c.req.param("id");
    const kind = CsvKindSchema.safeParse(c.req.query("kind") ?? "edges");
    if (!kind.success)
      throw badRequest("kind must be one of edges, convergences, exposure, touchpoints");
    const csv = toCsv(kind.data as CsvKind, finishedResult(id));
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="fot-${id}-${kind.data}.csv"`,
    });
  });

  app.get("/api/screen/:chain/:address", (c) => {
    const chain = ChainIdSchema.safeParse(c.req.param("chain"));
    if (!chain.success) throw badRequest(`chain must be one of ${CHAIN_IDS.join(", ")}`);
    const address = c.req.param("address");
    if (!isValidAddress(chain.data, address)) {
      throw badRequest(`not a valid ${chain.data} address`);
    }
    return c.json({
      labels: runtime.labels.lookup(chain.data, address),
      sanctioned: runtime.labels.isSanctioned(chain.data, address),
    });
  });

  app.get("*", async (c) => {
    if (webRoot === null || c.req.path.startsWith("/api/")) return c.notFound();
    const index = resolve(webRoot, "index.html");
    if (!existsSync(index)) return c.notFound();
    const asked = resolve(webRoot, `.${decodeURIComponent(c.req.path)}`);
    if (asked.startsWith(webRoot + sep) && isFile(asked)) return new Response(Bun.file(asked));
    return new Response(Bun.file(index), { headers: { "Cache-Control": "no-cache" } });
  });

  return app;
}
