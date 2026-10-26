// Surveyor: discovery. It takes stock of the live hackathon sources Zetaris
// federates, and when a builder the scout has never seen asks to be scouted,
// it extends the data estate at run time: it registers that builder's GitHub
// repos and profile README in Zetaris as new Lightning REST tables, caches
// them, and adds a flattened view. A builder seen before gets a fresh fetch.

import type { ZetarisClient } from "../adapters/zetaris.ts";
import { DataDesk, registerSource, rowsOf, num, str } from "../data.ts";
import type { ExecutionContract } from "./intake.ts";
import { CONTAINER, USERS_DB, builderDdl, readmeRaw, repoRaw, repoView, safeLogin } from "../sources.ts";
import type { Trace } from "../trace.ts";

export interface Survey {
  sources: { source: string; state: string; n: number; online: number }[];
  total: number;
  builder: { login: string; status: "registered" | "refreshed" | "mirror" | "missing"; repos: number };
  evidence: string[];
}

export async function survey(login: string, data: DataDesk, zetaris: ZetarisClient, trace: Trace, contract: () => ExecutionContract): Promise<Survey> {
  const evidence: string[] = [];
  const inv = await data.query(
    `SELECT source, state, COUNT(*) AS n, SUM(online) AS online FROM ${CONTAINER}.hackathons GROUP BY source, state ORDER BY source, state`,
    "inventory of live hackathon sources", "Surveyor"
  );
  evidence.push(inv.queryId);
  const sources = rowsOf(inv).map((r) => ({ source: str(r.source), state: str(r.state), n: num(r.n), online: num(r.online) }));
  const total = sources.reduce((a, s) => a + s.n, 0);
  trace.log({
    agent_name: "Surveyor", action: "inventory", status: "success",
    input_summary: "Zetaris: scout.hackathons by source",
    output_summary: `${total} live hackathons: ${sources.map((s) => `${s.source} ${s.state} ${s.n} (${s.online} online)`).join(", ")}`,
    data: { sources, queryId: inv.queryId },
  });

  // The builder's GitHub, as a source of its own.
  const l = safeLogin(login);
  let status: Survey["builder"]["status"] = "mirror";
  if (zetaris.mode === "live") {
    const ddl = builderDdl(l);
    const results: string[] = [];
    for (const sql of ddl) results.push(await registerSource(data, zetaris, trace, contract, sql, "Surveyor"));
    const fresh = results[0] === "created";
    if (!fresh) {
      // Seen before: re-fetch so the profile reflects today's repos.
      for (const t of [repoRaw(l), readmeRaw(l)]) {
        await registerSource(data, zetaris, trace, contract, `UNCACHE TABLE IF EXISTS ${USERS_DB.toLowerCase()}.${t}`, "Surveyor").catch(() => "exists");
        await registerSource(data, zetaris, trace, contract, `CACHE TABLE ${USERS_DB.toLowerCase()}.${t}`, "Surveyor").catch(() => "exists");
      }
    }
    status = fresh ? "registered" : "refreshed";
  }

  let repos = 0;
  try {
    const c = await data.query(`SELECT COUNT(*) AS n FROM ${CONTAINER}.${repoView(l)} WHERE is_fork = 0`, `size of ${l}'s GitHub`, "Surveyor");
    evidence.push(c.queryId);
    repos = num(c.rows[0]?.[0]);
  } catch (e) {
    status = "missing";
    trace.log({ agent_name: "Surveyor", action: "builder_missing", status: "error", input_summary: `GitHub user ${l}`, output_summary: `could not read ${l}'s repos: ${(e as Error).message.slice(0, 160)}` });
  }
  if (status !== "missing") {
    trace.log({
      agent_name: "Surveyor", action: status === "registered" ? "register_source" : "refresh_source", target_agent: "Profiler", status: "success",
      input_summary: `GitHub user ${l}`,
      output_summary: status === "registered"
        ? `new source: registered ${l}'s repos and README in Zetaris (${USERS_DB}.${repoRaw(l)}, ${USERS_DB}.${readmeRaw(l)}), cached, view scout.${repoView(l)}; ${repos} original repos`
        : status === "refreshed" ? `known builder: re-fetched ${l}'s GitHub through Zetaris; ${repos} original repos` : `sample mode: ${l}'s GitHub snapshot from the local mirror; ${repos} original repos`,
      data: { login: l, status, repos },
    });
  }
  return { sources, total, builder: { login: l, status, repos }, evidence };
}
