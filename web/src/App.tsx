import { useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------- types (mirror the API)

type Verdict = "START" | "BENCH" | "OUT";
interface TraceEvent { timestamp: string; agent_name: string; action: string; input_summary: string; output_summary: string; status: string; model?: string; data?: Record<string, any> }
interface Hackathon { key: string; sources: { source: string; id: string; url: string }[]; name: string; organizer: string; online: boolean; location: string; closes: string | null; daysLeft: number | null; prizeText: string; prizeUsd: number; registrations: number; themes: string[]; inviteOnly: boolean; state: string; tags: string[]; needs: string[]; evidence: string[] }
interface Fixture { hackathon: Hackathon; fit: number; verdict: Verdict; repo: string | null; why: string; hours: number; pWin: number; evPerHour: number; by: "model" | "playbook"; model?: string; coach: string[]; memory: string[] }
interface Win { hackathon: string; project: string; tags: string[] }
interface Repo { name: string; language: string; description: string; tags: string[]; stars: number; pushedAt: string }
interface Builder { login: string; repos: Repo[]; languages: [string, number][]; skills: [string, number][]; wins: Win[]; summary: string; evidence: string[]; record: { tag: string; won: number; placed: number; lost: number }[] }
interface DocketEntry { key: string; name: string; url: string; closes: string | null; prizeUsd: number; status: string; fit: number; evPerHour: number; hours: number; repo: string | null; result?: string }
interface Result {
  run_id: string; status: string;
  output: { summary: string; builder?: Builder; fixtures: Fixture[]; plan?: { hours: number; used: number; picks: string[]; expectedUsd: number }; note: string; log: { kind: string; text: string }[]; sources?: { source: string; state: string; n: number; online: number }[]; docket?: { entries: DocketEntry[] }; clarification?: { question: string; options: string[] } };
  contract?: { contractId: string; lineage: string[]; risk: { level: string; flags: string[]; reason?: string }; authority: Record<string, unknown> };
  engines: Record<string, string>; cost: { spent?: { modelCalls: number; queries: number; seconds: number } }; data_sources: Record<string, number>; execution_time_seconds: number;
}
interface Health { sample_mode: boolean; busy: boolean; provider: { status: string; deep: string }; zetaris: { mode: string; ok: boolean }; sample_builders?: string[] }

const LABEL: Record<string, string> = { agents: "Agents", trading: "Trading", payments: "Payments", onchain: "Onchain", consumer: "Consumer", games: "Games", fullstack: "Full-stack", dataviz: "Data viz", devtools: "Dev tools", privacy: "Privacy", bio: "Health", education: "Education", impact: "Impact", writing: "Writing", ml: "ML", hardware: "Hardware" };
const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);
const days = (d: number | null) => (d === null ? "?" : d === 0 ? "today" : `${d}d`);
const AGENT_ORDER = ["Intake", "Surveyor", "Profiler", "Archivist", "Reconciler", "Budget", "Scout", "Coach", "Executor"];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  return (await r.json()) as T;
}

function rating(fit: number): string {
  return fit >= 80 ? "r-hi" : fit >= 65 ? "r-good" : fit >= 45 ? "r-mid" : "r-low";
}

// ---------------------------------------------------------------- app

export default function App() {
  const [login, setLogin] = useState(() => new URLSearchParams(location.search).get("github") ?? "neromtoobad");
  const [hours, setHours] = useState(38);
  const [health, setHealth] = useState<Health | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Verdict | "ALL">("ALL");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<any>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [toast, setToast] = useState("");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => null);
    const q = new URLSearchParams(location.search).get("github");
    api<any>(q ? `/api/latest/${q}` : "/api/latest").then((j) => {
      if (j?.result) {
        setResult(j.result);
        setEvents(j.events ?? []);
        if (j.result.output.builder) setLogin(j.result.output.builder.login);
      }
    }).catch(() => null);
  }, []);

  function scout(e?: React.FormEvent) {
    e?.preventDefault();
    if (!login.trim() || running) return;
    setRunning(true);
    setError("");
    setEvents([]);
    setOpen(null);
    api<{ run_id?: string; error?: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ github: login.trim(), hours }) }).then((r) => {
      if (!r.run_id) {
        setRunning(false);
        setError(r.error ?? "could not start");
        return;
      }
      history.replaceState(null, "", `?github=${encodeURIComponent(login.trim())}`);
      esRef.current?.close();
      const es = new EventSource(`/api/jobs/${r.run_id}/events`);
      esRef.current = es;
      es.addEventListener("trace", (m) => setEvents((x) => [...x, JSON.parse((m as MessageEvent).data)]));
      es.addEventListener("done", (m) => {
        const res = JSON.parse((m as MessageEvent).data) as Result;
        es.close();
        setRunning(false);
        if (res.status === "success" && res.output.builder) setResult(res);
        else setError(res.output.summary);
      });
      es.onerror = () => { es.close(); setRunning(false); };
    });
  }

  async function report(f: Fixture, outcome: "won" | "placed" | "lost") {
    const b = result?.output.builder;
    if (!b) return;
    const r = await api<Result>("/api/results", { method: "POST", body: JSON.stringify({ github: b.login, hackathon: f.hackathon.name, outcome }) });
    setToast(r.output?.summary ?? "Recorded.");
    setTimeout(() => setToast(""), 6000);
  }

  async function showEvidence(id: string, focus?: string) {
    setEvidence({ queryId: id, loading: true });
    const e = await api<any>(`/api/evidence/${id}`);
    // Opened from a fixture: that hackathon's row first, highlighted.
    if (focus && Array.isArray(e.rows)) {
      const hit = (r: unknown[]) => r.some((v) => String(v) === focus);
      e.rows = [...e.rows.filter(hit), ...e.rows.filter((r: unknown[]) => !hit(r))];
      e.focus = focus;
    }
    setEvidence(e);
  }

  const out = result?.output;
  const b = out?.builder;
  const fixtures = out?.fixtures ?? [];
  const counts = useMemo(() => ({ START: fixtures.filter((f) => f.verdict === "START").length, BENCH: fixtures.filter((f) => f.verdict === "BENCH").length, OUT: fixtures.filter((f) => f.verdict === "OUT").length }), [fixtures]);
  const shown = fixtures.filter((f) => filter === "ALL" || f.verdict === filter);
  const visible = showAll ? shown : shown.slice(0, filter === "OUT" ? 12 : 8);
  const live = health && !health.sample_mode && health.zetaris.mode === "live";
  const total = out?.sources?.reduce((a, s) => a + s.n, 0) ?? 0;
  const lastStep = [...events].reverse().find((e) => e.agent_name !== "System");
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="app">
      <header className="top">
        <div className="logo"><i /><span>Docket Scout</span></div>
        <span className="mono sub">Scouting report · {today} · {total ? `${total} live hackathons` : "live hackathons"} via Zetaris</span>
        <form className="who" onSubmit={scout}>
          <span className="mono">github /</span>
          <input value={login} onChange={(e) => setLogin(e.target.value.replace(/[^A-Za-z0-9-]/g, ""))} placeholder="username" spellCheck={false} aria-label="GitHub username" />
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Hours this week">
            {[12, 20, 30, 38, 50, 70].map((h) => <option key={h} value={h}>{h}h this week</option>)}
          </select>
          <button className="btn" disabled={running || !login}>{running ? "Scouting…" : "Scout this builder"}</button>
        </form>
      </header>

      <div className="status">
        <span className={`dot ${live ? "on" : ""}`} />{health ? (health.sample_mode ? "Sample mode: recorded Zetaris results" : `Zetaris ${health.zetaris.ok ? "live" : "offline"}`) : "…"}
        <span className={`dot ${health?.provider.status === "online" ? "on" : ""}`} />{health ? (health.provider.status === "online" ? "Nemotron via Meterless Nightshift" : "Scout playbook (no model)") : ""}
        {result?.contract && <span className="contract" title="Scout Intent execution contract">Signed contract {result.contract.contractId.slice(0, 8)} · may shortlist and add deadlines · never registers, submits or messages</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {running && (
        <section className="matchday">
          <div className="md-head"><span className="mono">Live · scouting {login}</span><b>{lastStep ? `${lastStep.agent_name}: ${lastStep.output_summary.slice(0, 120)}` : "Signing the contract…"}</b></div>
          <div className="md-agents">
            {AGENT_ORDER.map((a) => {
              const seen = events.some((e) => e.agent_name === a);
              const now = lastStep?.agent_name === a;
              return <span key={a} className={`${seen ? "seen" : ""} ${now ? "now" : ""}`}>{a}</span>;
            })}
          </div>
          <ol className="md-feed">
            {events.filter((e) => e.agent_name !== "System" || e.action === "step_start").slice(-7).map((e, i) => (
              <li key={i}><span className="mono">{e.agent_name}</span>{e.output_summary.slice(0, 200)}</li>
            ))}
          </ol>
        </section>
      )}

      {!b && !running && (
        <section className="empty">
          <h1>Who are we scouting?</h1>
          <p>Type any GitHub username. The scout reads their public repos and profile README through Zetaris, checks every live hackathon on Devpost and Devfolio, and tells them which to enter with the hours they have.</p>
          {health?.sample_mode && health.sample_builders?.length ? <p className="mono">Sample mode builders: {health.sample_builders.join(", ")}</p> : null}
        </section>
      )}

      {b && out && (
        <div className="grid">
          <aside className="player">
            <span className="mono">Builder profile · from {b.repos.length} public repos</span>
            <div className="ph">
              <img src={`https://github.com/${b.login}.png?size=120`} alt="" />
              <h2>{b.login}</h2>
            </div>
            <div className="pos">
              {b.skills.slice(0, 3).map(([t], i) => <span key={t} className={i === 0 ? "lead" : ""}>{LABEL[t] ?? t}</span>)}
              {b.languages[0] && <span>{b.languages[0][0]}</span>}
            </div>
            <div className="attrs">
              {b.skills.slice(0, 6).map(([t, v]) => <div key={t} className="attr"><span>{LABEL[t] ?? t}</span><b>{v}</b></div>)}
            </div>
            <p className="summary">{b.summary}</p>

            <div className="cab">
              <p className="mono">Trophy cabinet · from the profile README</p>
              {b.wins.length ? (
                <ul className="wins">{b.wins.map((w) => <li key={w.hackathon}><i>W</i><span><b>{w.hackathon}</b>{w.project ? ` · ${w.project}` : ""}</span></li>)}</ul>
              ) : <p className="soft">No wins table on the profile README yet. Report results below and the scout will learn.</p>}
            </div>

            <div className="cab">
              <p className="mono">Record by skill · H-MEM</p>
              {b.record.length ? (
                <div className="bars">
                  {[...b.record].sort((x, y) => y.won * 3 + y.placed - (x.won * 3 + x.placed)).slice(0, 5).map((r) => {
                    const n = r.won + r.placed + r.lost;
                    return <div key={r.tag}><span>{LABEL[r.tag] ?? r.tag}</span><i style={{ ["--w" as any]: `${Math.round(((r.won + r.placed * 0.5) / Math.max(1, n)) * 100)}%` }} /><b>{r.won}W {r.placed}P {r.lost}L</b></div>;
                  })}
                </div>
              ) : <p className="soft">Nothing remembered yet.</p>}
            </div>
            <p className="mono langs">{b.languages.slice(0, 5).map(([l, n]) => `${l} ${n}`).join(" · ")}</p>
          </aside>

          <main className="right">
            <h1>This week's fixtures:<br /><span>play {out.plan?.picks.length ?? 0}</span>, rest the rest.</h1>
            <div className="planbar">
              <div className="pb-track"><i style={{ width: `${Math.min(100, ((out.plan?.used ?? 0) / Math.max(1, out.plan?.hours ?? 1)) * 100)}%` }} /></div>
              <span className="mono">{out.plan?.used ?? 0}h of {out.plan?.hours ?? hours}h planned · expected about {usd(out.plan?.expectedUsd ?? 0)} · {total} live across {new Set(out.sources?.map((s) => s.source)).size} platforms</span>
            </div>

            <div className="filters">
              {(["ALL", "START", "BENCH", "OUT"] as const).map((v) => (
                <button key={v} className={filter === v ? "on" : ""} onClick={() => { setFilter(v); setShowAll(false); }}>{v === "ALL" ? "All" : v === "START" ? "Start" : v === "BENCH" ? "Bench" : "Out"} <i>{v === "ALL" ? fixtures.length : counts[v]}</i></button>
              ))}
            </div>

            <div className="fx">
              {visible.map((f) => {
                const h = f.hackathon;
                const isOpen = open === h.key;
                return (
                  <article key={h.key} className={`match v-${f.verdict} ${isOpen ? "open" : ""}`}>
                    <button className="m-row" onClick={() => setOpen(isOpen ? null : h.key)} aria-expanded={isOpen}>
                      <div className="ko"><span className="mono">Closes</span><b>{days(h.daysLeft)}</b></div>
                      <div className="vs">You vs {h.name}<small>{h.sources.map((s) => s.source).join(" + ")} · {usd(h.prizeUsd)}{h.prizeText && !h.prizeText.startsWith("$") ? ` (${h.prizeText})` : ""} · {h.registrations.toLocaleString("en-US")} registered{h.online ? "" : ` · in person`}</small></div>
                      <div className="rv"><div className={`rating ${rating(f.fit)}`}>{f.fit}</div><span className={`verdict ${f.verdict}`}>{f.verdict === "START" ? "Start" : f.verdict === "BENCH" ? "Bench" : "Out"}</span></div>
                      <div className="xp">{f.verdict === "OUT" ? "—" : `$${f.evPerHour}/h`}<small>{f.verdict === "OUT" ? "not for you" : `${f.hours}h build`}</small></div>
                      <div className="lineup">{f.repo ? <span className="repo">{f.repo}</span> : <span className="none">no head start</span>}<span className="why">{f.why}</span></div>
                    </button>
                    {isOpen && (
                      <div className="m-more">
                        <div className="mm-col">
                          <p className="mono">Scout's read{f.by === "model" ? ` · ${f.model?.replace("nvidia/", "") ?? "Nemotron"}` : " · playbook"}</p>
                          <p>{f.why}</p>
                          {f.coach.length > 0 && <><p className="mono">Coach</p><ul>{f.coach.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
                          {f.memory.length > 0 && <><p className="mono">From memory (H-MEM)</p><ul>{f.memory.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
                        </div>
                        <div className="mm-col">
                          <p className="mono">The numbers</p>
                          <dl>
                            <dt>Prize</dt><dd>{usd(h.prizeUsd)}{h.prizeText && !h.prizeText.startsWith("$") ? ` from ${h.prizeText}` : ""}</dd>
                            <dt>Closes</dt><dd>{h.closes ?? "not given"}</dd>
                            <dt>Odds</dt><dd>{(f.pWin * 100).toFixed(1)}% to win, about ${f.evPerHour} per build hour</dd>
                            <dt>Themes</dt><dd>{h.themes.join(", ") || "—"}</dd>
                            <dt>Where</dt><dd>{h.location}</dd>
                          </dl>
                          <p className="ev">{h.evidence.map((q) => <button key={q} onClick={() => showEvidence(q, h.name)}>{q}</button>)}{b.evidence.slice(0, 1).map((q) => <button key={q} onClick={() => showEvidence(q)}>{q}</button>)}</p>
                          <div className="acts">
                            {h.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">Open on {s.source} ↗</a>)}
                            <span className="mono">After it closes:</span>
                            <button onClick={() => report(f, "won")}>Won</button><button onClick={() => report(f, "placed")}>Placed</button><button onClick={() => report(f, "lost")}>Didn't place</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
              {shown.length > visible.length && <button className="more" onClick={() => setShowAll(true)}>Show all {shown.length}</button>}
            </div>

            <div className="note"><b>Scout's note.</b> {out.note}</div>

            <div className="lower">
              <section className="card log">
                <p className="mono">Scout log</p>
                <ul>{out.log.map((l, i) => <li key={i}><span className={`k k-${l.kind}`}>{({ fx: "FX", merged: "Merged", deadline_moved: "Moved", prize_changed: "Prize", new: "New", source: "Source", skip: "Skipped" } as Record<string, string>)[l.kind] ?? l.kind}</span>{l.text}</li>)}</ul>
              </section>
              <section className="card docket">
                <p className="mono">Your docket</p>
                <ul>{(out.docket?.entries ?? []).filter((e) => e.status === "shortlist").map((e) => <li key={e.key}><b>{e.name}</b><span>{e.closes ?? "?"} · {e.hours}h{e.result ? ` · ${e.result}` : ""}</span></li>)}</ul>
                <a className="cal" href={`/api/docket/${b.login}/calendar`}>Add deadlines to calendar (.ics)</a>
              </section>
            </div>

            <footer className="engines">
              <span><b>Zetaris</b> {Object.entries(result!.data_sources).map(([k, v]) => `${v} ${k}`).join(", ")} queries</span>
              <span><b>Scout Intent</b> {result!.engines.scout_intent}</span>
              <span><b>H-MEM</b> {result!.engines.hmem}</span>
              <span><b>World Model</b> {result!.engines.world_model}</span>
              <span><b>Markovian</b> {result!.engines.markovian?.split(",")[0]}</span>
              <span><b>Nemotron</b> {result!.cost.spent?.modelCalls ?? 0} calls · {result!.execution_time_seconds}s</span>
              <button onClick={() => setLogOpen(true)}>Match log ({events.length})</button>
            </footer>
          </main>
        </div>
      )}

      {evidence && (
        <div className="drawer" onClick={() => setEvidence(null)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="ph2"><p className="mono">Evidence · {evidence.queryId} · {evidence.recordedAt ? `ran on Zetaris ${evidence.recordedAt.slice(0, 16).replace("T", " ")}` : "Zetaris"}</p><button onClick={() => setEvidence(null)}>Close</button></div>
            {evidence.loading ? <p>Loading…</p> : evidence.error ? <p>{evidence.error}</p> : (
              <>
                <pre>{evidence.sql}</pre>
                <div className="tbl"><table><thead><tr>{(evidence.columns ?? []).map((c: string) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{(evidence.rows ?? []).slice(0, 40).map((r: unknown[], i: number) => <tr key={i} className={evidence.focus && r.some((v) => String(v) === evidence.focus) ? "hi" : ""}>{r.map((v, j) => <td key={j}>{String(v ?? "∅").slice(0, 80)}</td>)}</tr>)}</tbody></table></div>
                <p className="mono">{(evidence.rows ?? []).length} rows{(evidence.rows ?? []).length > 40 ? " (first 40 shown)" : ""}</p>
              </>
            )}
          </div>
        </div>
      )}

      {logOpen && (
        <div className="drawer" onClick={() => setLogOpen(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="ph2"><p className="mono">Match log · every query, proposal, objection and action</p><button onClick={() => setLogOpen(false)}>Close</button></div>
            <ol className="trace">{events.map((e, i) => <li key={i} className={`s-${e.status}`}><span className="mono">{e.timestamp.slice(11, 19)} {e.agent_name}{e.model ? ` · ${e.model.replace("nvidia/", "")}` : ""}</span><b>{e.action}</b> {e.output_summary}{e.data?.queryId && <button onClick={() => { setLogOpen(false); showEvidence(e.data!.queryId); }}>{e.data.queryId}</button>}</li>)}</ol>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
