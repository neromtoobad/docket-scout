// HTTP entry point.
//   POST /run                         run one job and return the JSON result (judges' programmatic path)
//   POST /api/jobs                    start a job in the background { query, github?, hours? }, returns { run_id }
//   GET  /api/jobs/:id                job status / result
//   GET  /api/jobs/:id/events         live trace (server-sent events) for the UI
//   GET  /api/latest/:login           the latest finished scouting report for a builder
//   POST /api/results                 the builder reports a result { github, hackathon, outcome: won|placed|lost }
//   GET  /api/docket/:login           the builder's docket (shortlist, watch list, results)
//   GET  /api/docket/:login/calendar  the shortlist's deadlines as an .ics file
//   GET  /api/evidence/:queryId       the exact Zetaris SQL and rows behind a number
//   GET  /api/memory/:login           what the scout remembers about a builder (H-MEM)
//   POST /api/reset                   demo reset: forget memory, dockets and the seen-list
//   GET  /api/health                  provider + data status
//   GET  /                            the scouting report UI (web/dist)

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { MeterlessProvider } from "./adapters/meterless.ts";
import { ZetarisClient } from "./adapters/zetaris.ts";
import { mirrorBuilders } from "./adapters/mirror.ts";
import { scoutMemory, wipeArchives } from "./agents/archivist.ts";
import { calendar, readDocket } from "./agents/executor.ts";
import { safeLogin } from "./sources.ts";
import { AGENTS, runJob, type RunInput, type RunOutput } from "./run.ts";
import type { Trace, TraceEvent } from "./trace.ts";

const app = new Hono();

interface Job {
  id: string;
  question: string;
  login?: string;
  status: "running" | "done";
  startedAt: string;
  events: TraceEvent[];
  result?: RunOutput;
  listeners: Set<(e: TraceEvent | { type: "done"; result: RunOutput }) => void>;
}
const jobs = new Map<string, Job>();
let busy = false; // one job at a time: H-MEM and the dockets are a single system of record

const jobDir = () => join(config.dataDir, "jobs");
function persist(job: Job): void {
  mkdirSync(jobDir(), { recursive: true });
  const { listeners: _l, ...rest } = job;
  writeFileSync(join(jobDir(), `${job.id}.json`), JSON.stringify(rest));
}
if (existsSync(jobDir())) {
  for (const f of readdirSync(jobDir()).sort().slice(-30)) {
    const j = JSON.parse(readFileSync(join(jobDir(), f), "utf8")) as Omit<Job, "listeners">;
    jobs.set(j.id, { ...j, listeners: new Set() });
  }
}

function parseInput(body: unknown): RunInput | null {
  const b = body as Partial<RunInput> & { query?: string; github?: string; hours?: number };
  const github = b?.input?.github ?? b?.github;
  const hours = Number(b?.input?.hours ?? b?.hours) || undefined;
  const query = b?.input?.query ?? b?.query ?? (github ? `scout ${github}${hours ? `, ${hours} hours` : ""}` : undefined);
  if (typeof query !== "string" || !query.trim()) return null;
  return { run_id: b.run_id, input: { query: query.slice(0, 600), github: github ? safeLogin(String(github)) : undefined, hours }, options: b.options };
}

function startJob(req: RunInput): Job {
  const id = req.run_id ?? `run-${Date.now().toString(36)}`;
  req.run_id = id;
  const job: Job = { id, question: req.input.query, login: req.input.github, status: "running", startedAt: new Date().toISOString(), events: [], listeners: new Set() };
  jobs.set(id, job);
  busy = true;
  runJob(req, {
    onTrace: (t: Trace) => t.subscribe((e) => {
      job.events.push(e);
      for (const l of job.listeners) l(e);
    }),
  }).then((result) => {
    job.status = "done";
    job.result = result;
    job.login ??= result.output.builder?.login;
    busy = false;
    persist(job);
    for (const l of job.listeners) l({ type: "done", result });
  });
  return job;
}

app.post("/run", async (c) => {
  const req = parseInput(await c.req.json().catch(() => null));
  if (!req) return c.json({ status: "error", error: { type: "BadRequest", message: 'expected {"input":{"query":"..."}}', recoverable: true } }, 400);
  const res = await runJob(req);
  return c.json(res, res.status === "error" ? 500 : 200);
});

app.post("/api/jobs", async (c) => {
  const req = parseInput(await c.req.json().catch(() => null));
  if (!req) return c.json({ error: 'expected {"query":"..."} or {"github":"..."}' }, 400);
  if (busy) return c.json({ error: "the scout is already working on a job" }, 409);
  return c.json({ run_id: startJob(req).id });
});

app.get("/api/jobs", (c) => c.json([...jobs.values()].reverse().slice(0, 20).map((j) => ({ id: j.id, question: j.question, login: j.login, status: j.status, startedAt: j.startedAt, summary: j.result?.output.summary }))));

app.get("/api/jobs/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json({ id: job.id, question: job.question, status: job.status, startedAt: job.startedAt, events: job.events, result: job.result });
});

app.get("/api/jobs/:id/events", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    for (const e of job.events) await stream.writeSSE({ event: "trace", data: JSON.stringify(e) });
    if (job.status === "done") {
      await stream.writeSSE({ event: "done", data: JSON.stringify(job.result) });
      return;
    }
    await new Promise<void>((resolve) => {
      const l = (e: TraceEvent | { type: "done"; result: RunOutput }) => {
        if ("type" in e && e.type === "done") {
          stream.writeSSE({ event: "done", data: JSON.stringify(e.result) }).finally(() => {
            job.listeners.delete(l);
            resolve();
          });
        } else stream.writeSSE({ event: "trace", data: JSON.stringify(e) });
      };
      job.listeners.add(l);
      stream.onAbort(() => {
        job.listeners.delete(l);
        resolve();
      });
    });
  });
});

app.get("/api/latest/:login", (c) => {
  const login = safeLogin(c.req.param("login"));
  const job = [...jobs.values()].reverse().find((j) => j.status === "done" && j.result?.output.builder?.login === login);
  return job ? c.json({ id: job.id, startedAt: job.startedAt, events: job.events, result: job.result }) : c.json({ error: "not scouted yet" }, 404);
});

app.get("/api/latest", (c) => {
  const job = [...jobs.values()].reverse().find((j) => j.status === "done" && j.result?.output.builder);
  return job ? c.json({ id: job.id, startedAt: job.startedAt, events: job.events, result: job.result }) : c.json({ error: "nothing scouted yet" }, 404);
});

app.post("/api/results", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { github?: string; hackathon?: string; outcome?: string };
  if (!b.github || !b.hackathon || !["won", "placed", "lost"].includes(String(b.outcome))) return c.json({ error: 'expected {"github","hackathon","outcome":"won"|"placed"|"lost"}' }, 400);
  if (busy) return c.json({ error: "the scout is already working on a job" }, 409);
  const phrase = b.outcome === "won" ? "I won" : b.outcome === "placed" ? "I placed at" : "I didn't place at";
  const res = await runJob({ input: { query: `${phrase} ${String(b.hackathon).slice(0, 120)}`, github: safeLogin(b.github) } }, { quiet: true });
  return c.json(res, res.status === "success" ? 200 : 400);
});

app.get("/api/docket/:login", (c) => c.json(readDocket(safeLogin(c.req.param("login")))));

app.get("/api/docket/:login/calendar", (c) => {
  const login = safeLogin(c.req.param("login"));
  const d = readDocket(login);
  return c.body(calendar(login, d.entries.filter((e) => e.status === "shortlist" && !e.result)), 200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="docket-${login}.ics"` });
});

app.get("/api/evidence/:id", (c) => {
  const id = c.req.param("id").replace(/[^a-z0-9_]/gi, "");
  const file = join("data/cache", `${id}.json`);
  if (existsSync(file)) return c.json({ queryId: id, ...JSON.parse(readFileSync(file, "utf8")) });
  for (const j of [...jobs.values()].reverse()) {
    const e = j.events.find((x) => x.action === "zetaris_query" && x.data?.queryId === id);
    if (e) return c.json({ queryId: id, ...e.data });
  }
  return c.json({ error: "unknown query id" }, 404);
});

app.get("/api/memory/:login", (c) => {
  const login = safeLogin(c.req.param("login"));
  const all = scoutMemory().store.all().filter((m) => m.tags?.includes(`builder:${login}`));
  return c.json(all.slice(-60).reverse().map((m) => ({ id: m.id, content: m.content, tags: m.tags, refs: m.provenance?.refs ?? [], at: new Date(m.timestamp).toISOString() })));
});

app.post("/api/reset", (c) => {
  if (busy) return c.json({ error: "the scout is already working on a job" }, 409);
  wipeArchives();
  for (const p of ["docket", "seen.json"]) rmSync(join(config.dataDir, p), { recursive: true, force: true });
  jobs.clear();
  rmSync(jobDir(), { recursive: true, force: true });
  return c.json({ ok: true });
});

app.get("/api/health", async (c) => {
  const provider = new MeterlessProvider();
  const [p, z] = await Promise.all([config.sampleMode ? Promise.resolve({ status: "offline", models: [] as string[], detail: "SAMPLE_MODE" }) : provider.status(), new ZetarisClient().ping()]);
  return c.json({
    sample_mode: config.sampleMode, busy,
    provider: { name: "Meterless Nightshift", base_url: provider.baseUrl, status: p.status, fast: config.meterless.fastModel, deep: config.meterless.deepModel, serves_lanes: p.models.includes(config.meterless.deepModel) },
    zetaris: { mode: new ZetarisClient().mode, ok: z.ok, detail: z.detail },
    sample_builders: config.sampleMode ? mirrorBuilders() : undefined,
    agents: AGENTS,
  });
});

app.get("/api/examples", (c) => {
  const dir = "input_examples";
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  return c.json([...new Set(files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).input.query as string))]);
});

if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[INFO] Docket Scout listening on http://${config.host}:${info.port} (sample_mode=${config.sampleMode})`);
});
