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
  const picks = fixtures.filter((f) => f.verdict === "START");
  const rest = fixtures.filter((f) => f.verdict !== "START");
  const counts = useMemo(() => ({ BENCH: fixtures.filter((f) => f.verdict === "BENCH").length, OUT: fixtures.filter((f) => f.verdict === "OUT").length }), [fixtures]);
  const shown = rest.filter((f) => filter === "ALL" || f.verdict === filter);
  const visible = showAll ? shown : shown.slice(0, filter === "OUT" ? 12 : 8);
  const live = health && !health.sample_mode && health.zetaris.mode === "live";
  const total = out?.sources?.reduce((a, s) => a + s.n, 0) ?? 0;
  const platforms = new Set(out?.sources?.map((s) => s.source)).size;
  const lastStep = [...events].reverse().find((e) => e.agent_name !== "System");
  const seenAgents = AGENT_ORDER.filter((a) => events.some((e) => e.agent_name === a)).length;
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="app">
      <header className="top">
        <div className="logo"><i /><span>Docket Scout</span></div>
        <span className="mono sub">Scouting report · {today}{total ? ` · ${total} live hackathons` : ""} via Zetaris</span>
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
        {result?.contract && <span className="contract" title="Scout Intent execution contract"><b>Signed contract {result.contract.contractId.slice(0, 8)}</b> may shortlist and add deadlines · never registers, submits or messages</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {running && (
        <section className="matchday">
          <div className="md-top">
            <div className="md-head"><span className="mono">Live · scouting {login} · {hours}h</span><b>{lastStep ? `${lastStep.agent_name}: ${lastStep.output_summary.slice(0, 130)}` : "Signing the contract…"}</b></div>
            <div className="md-clock"><span>{seenAgents}</span>/{AGENT_ORDER.length}</div>
          </div>
          <div className="md-bar"><i style={{ width: `${(seenAgents / AGENT_ORDER.length) * 100}%` }} /></div>
          <div className="md-agents">
            {AGENT_ORDER.map((a) => <span key={a} className={`${events.some((e) => e.agent_name === a) ? "seen" : ""} ${lastStep?.agent_name === a ? "now" : ""}`}>{a}</span>)}
          </div>
          <ol className="md-feed">
            {events.filter((e) => e.agent_name !== "System" || e.action === "step_start").slice(-6).map((e, i) => <li key={i}><span className="mono">{e.agent_name}</span>{e.output_summary.slice(0, 210)}</li>)}
          </ol>
        </section>
      )}

      {!b && !running && (
        <section className="empty">
          <div className="pitch-lines" aria-hidden="true" />
          <span className="mono">Docket Scout</span>
          <h1>Who are we<br />scouting?</h1>
          <p>Type any GitHub username. The scout reads their public repos and profile README through Zetaris, checks every live hackathon on Devpost and Devfolio, and tells them which to enter with the hours they have.</p>
          <div className="try">{(health?.sample_mode ? health.sample_builders ?? [] : ["neromtoobad", "karpathy", "sindresorhus"]).map((l) => <button key={l} onClick={() => setLogin(l)}>{l}</button>)}</div>
        </section>
      )}

      {b && out && (
        <div className="grid">
          <aside className="player">
            <div className="pitch-lines" aria-hidden="true" />
            <span className="mono">Builder profile · from {b.repos.length} public repos</span>
            <div className="ph">
              <img src={`https://github.com/${b.login}.png?size=120`} alt="" />
              <div><h2>{b.login}</h2><span className="mono">{b.languages.slice(0, 2).map(([l]) => l).join(" · ")}</span></div>
            </div>
            <div className="pos">
              {b.skills.slice(0, 3).map(([t], i) => <span key={t} className={i === 0 ? "lead" : ""}>{LABEL[t] ?? t}</span>)}
              <span>{b.wins.length} wins</span>
            </div>
            <Radar skills={b.skills.slice(0, 6)} />
            <p className="summary">{b.summary}</p>

            <div className="cab">
              <p className="mono">Trophy cabinet · from the profile README</p>
              {b.wins.length ? (
                <ul className="wins">{b.wins.map((w) => <li key={w.hackathon}><i>W</i><span><b>{w.hackathon}</b>{w.project ? <em> · {w.project}</em> : null}</span></li>)}</ul>
              ) : <p className="soft">No wins table on the profile README yet. Report results on a fixture and the scout will learn.</p>}
            </div>

            <div className="cab">
              <p className="mono">Record by skill · H-MEM</p>
              {b.record.length ? (
                <div className="record">
                  {[...b.record].sort((x, y) => y.won * 3 + y.placed - (x.won * 3 + x.placed)).slice(0, 6).map((r) => (
                    <div key={r.tag}><span>{LABEL[r.tag] ?? r.tag}</span><i>{[...Array(r.won)].map((_, k) => <b key={`w${k}`} className="pw">W</b>)}{[...Array(r.placed)].map((_, k) => <b key={`p${k}`} className="pp">P</b>)}{[...Array(r.lost)].map((_, k) => <b key={`l${k}`} className="pl">L</b>)}</i></div>
                  ))}
                </div>
              ) : <p className="soft">Nothing remembered yet.</p>}
            </div>
          </aside>

          <main className="right">
            <section className="hero">
              <h1>This week's fixtures:<br /><span>play {picks.length}</span>, rest the rest.</h1>
              <MatchClock picks={picks} hours={out.plan?.hours ?? hours} />
              <div className="tickets">
                {picks.map((f, i) => <Ticket key={f.hackathon.key} f={f} n={i + 1} onEvidence={(q) => showEvidence(q, f.hackathon.name)} onOpen={() => { setFilter("ALL"); setOpen(f.hackathon.key); }} />)}
                {!picks.length && <div className="ticket empty-t"><b>No starters this week.</b><span>Nothing clears the rules and the $25/h floor within your hours. The bench below is worth watching.</span></div>}
              </div>
              <div className="note"><span className="mono">Scout's note</span>{out.note}</div>
            </section>

            <section className="stats">
              <div><b>{total}</b><span>live hackathons</span></div>
              <div><b>{platforms + 2}</b><span>live sources: {[...new Set(out.sources?.map((x) => x.source))].join(", ")}, FX, GitHub</span></div>
              <div><b>{Object.values(result!.data_sources).reduce((a, v) => a + v, 0)}</b><span>Zetaris queries ({Object.keys(result!.data_sources).join(", ")})</span></div>
              <div><b>{result!.cost.spent?.modelCalls ?? 0}</b><span>Nemotron calls</span></div>
              <div><b>{result!.engines.markovian?.match(/^\d+/)?.[0] ?? "–"}</b><span>Markovian steps</span></div>
              <div><b>{Math.round(result!.execution_time_seconds)}s</b><span>scouting time</span></div>
            </section>

            <div className="rest-head">
              <h3>The rest</h3>
              <div className="filters">
                {(["ALL", "BENCH", "OUT"] as const).map((v) => (
                  <button key={v} className={filter === v ? "on" : ""} onClick={() => { setFilter(v); setShowAll(false); }}>{v === "ALL" ? "All" : v === "BENCH" ? "Bench" : "Out"} <i>{v === "ALL" ? rest.length : counts[v]}</i></button>
                ))}
              </div>
            </div>

            <div className="fx">
              {[...(open && picks.some((p) => p.hackathon.key === open) ? picks.filter((p) => p.hackathon.key === open) : []), ...visible].map((f) => {
                const h = f.hackathon;
                const isOpen = open === h.key;
                return (
                  <article key={h.key} className={`match v-${f.verdict} ${isOpen ? "open" : ""}`}>
                    <button className="m-row" onClick={() => setOpen(isOpen ? null : h.key)} aria-expanded={isOpen}>
                      <div className={`ko ${h.daysLeft !== null && h.daysLeft <= 3 ? "soon" : ""}`}><span className="mono">Closes</span><b>{days(h.daysLeft)}</b></div>
                      <div className="vs"><span className="plat">{h.sources.map((s) => s.source).join(" + ")}</span>You vs {h.name}<small>{h.registrations.toLocaleString("en-US")} registered{h.online ? "" : ` · in person: ${h.location}`}</small></div>
                      <div className="prize">{usd(h.prizeUsd)}<small>{h.prizeText && !h.prizeText.startsWith("$") ? h.prizeText : "prize"}</small></div>
                      <div className="rv"><div className={`rating ${rating(f.fit)}`}>{f.fit}</div><span className={`verdict ${f.verdict}`}>{f.verdict === "START" ? "Start" : f.verdict === "BENCH" ? "Bench" : "Out"}</span></div>
                      <div className="xp">{f.verdict === "OUT" ? "—" : `$${f.evPerHour}/h`}<small>{f.verdict === "OUT" ? "not for you" : `${f.hours}h build`}</small></div>
                      <div className="lineup">{f.repo ? <span className="repo">{f.repo}</span> : <span className="none">no head start</span>}<span className="why">{f.why}</span></div>
                    </button>
                    {isOpen && <Detail f={f} b={b} onEvidence={showEvidence} onReport={report} />}
                  </article>
                );
              })}
              {shown.length > visible.length && <button className="more" onClick={() => setShowAll(true)}>Show all {shown.length}</button>}
            </div>

            <div className="lower">
              <section className="card log">
                <p className="mono">Scout log</p>
                <ul>{out.log.map((l, i) => <li key={i}><span className={`k k-${l.kind}`}>{({ fx: "FX", merged: "Merged", deadline_moved: "Moved", prize_changed: "Prize", new: "New", source: "Source", skip: "Skipped" } as Record<string, string>)[l.kind] ?? l.kind}</span>{l.text}</li>)}</ul>
              </section>
              <section className="card sheet">
                <p className="mono">Team sheet · your docket</p>
                <ol>{(out.docket?.entries ?? []).filter((e) => e.status === "shortlist").map((e, i) => <li key={e.key}><i>{i + 1}</i><div><b>{e.name}</b><span>Submit by {e.closes ?? "?"} · {e.hours}h{e.repo ? ` · from ${e.repo}` : ""}{e.result ? ` · ${e.result}` : ""}</span></div></li>)}</ol>
                <p className="watch">{(out.docket?.entries ?? []).filter((e) => e.status === "watch").length} more on the watch list</p>
                <a className="cal" href={`/api/docket/${b.login}/calendar`}>Add deadlines to calendar ↓</a>
              </section>
            </div>

            <footer className="engines">
              <span><b>Scout Intent</b> {result!.engines.scout_intent}</span>
              <span><b>H-MEM</b> {result!.engines.hmem}</span>
              <span><b>World Model</b> {result!.engines.world_model}</span>
              <span><b>Markovian</b> {result!.engines.markovian?.split(",")[0]}</span>
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

// ---------------------------------------------------------------- pieces

const shortName = (n: string) => n.replace(/\(.*?\)/g, "").replace(/\b(Hackathon|Challenge|Competition|Partner)\b/gi, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");

function Radar({ skills }: { skills: [string, number][] }) {
  const n = skills.length;
  const R = 82, cx = 170, cy = 134;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(a) * R * (v / 100), cy + Math.sin(a) * R * (v / 100)];
  };
  const ring = (v: number) => skills.map((_, i) => pt(i, v).join(",")).join(" ");
  return (
    <svg className="radar" viewBox="0 0 340 262" role="img" aria-label={`Skills: ${skills.map(([t, v]) => `${LABEL[t] ?? t} ${v}`).join(", ")}`}>
      {[25, 50, 75, 100].map((v) => <polygon key={v} points={ring(v)} className="r-ring" />)}
      {skills.map((_, i) => { const [x, y] = pt(i, 100); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} className="r-axis" />; })}
      <polygon points={skills.map(([, v], i) => pt(i, v).join(",")).join(" ")} className="r-shape" />
      {skills.map(([t, v], i) => {
        const [x, y] = pt(i, 128);
        const anchor = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
        return (
          <g key={t}>
            <text x={x} y={y - 3} textAnchor={anchor} className="r-label">{LABEL[t] ?? t}</text>
            <text x={x} y={y + 15} textAnchor={anchor} className="r-val">{v}</text>
          </g>
        );
      })}
    </svg>
  );
}

function MatchClock({ picks, hours }: { picks: Fixture[]; hours: number }) {
  const used = picks.reduce((a, f) => a + f.hours, 0);
  return (
    <div className="clock">
      <div className="clock-bar">
        {picks.map((f, i) => <span key={f.hackathon.key} className={`seg s${i % 3}`} style={{ flex: f.hours }} title={`${f.hackathon.name}: ${f.hours}h`}><b>{shortName(f.hackathon.name)}</b><i>{f.hours}h</i></span>)}
        {hours - used > 0 && <span className="seg spare" style={{ flex: hours - used }}><i>{hours - used}h spare</i></span>}
      </div>
      <div className="clock-scale mono"><span>0h</span><span>{used}h of {hours}h planned · about {usd(picks.reduce((a, f) => a + f.hackathon.prizeUsd * 0.3 * f.pWin, 0))} expected</span><span>{hours}h</span></div>
    </div>
  );
}

function Ticket({ f, n, onEvidence, onOpen }: { f: Fixture; n: number; onEvidence: (q: string) => void; onOpen: () => void }) {
  const h = f.hackathon;
  const date = h.closes ? new Date(h.closes + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "?";
  return (
    <article className="ticket">
      <div className="t-top"><span className="t-n">{n}</span><span className="plat">{h.sources.map((s) => s.source).join(" + ")}</span><span className={`t-ko ${h.daysLeft !== null && h.daysLeft <= 3 ? "soon" : ""}`}>Closes {date} · {days(h.daysLeft)}</span></div>
      <h3>You vs {h.name}</h3>
      <div className="t-mid">
        <div className={`rating ${rating(f.fit)}`}>{f.fit}</div>
        <div className="t-ev"><b>${f.evPerHour}<i>/h</i></b><span>expected per build hour</span></div>
        <dl><dt>Prize</dt><dd>{usd(h.prizeUsd)}{h.prizeText && !h.prizeText.startsWith("$") ? ` (${h.prizeText})` : ""}</dd><dt>Odds</dt><dd>{(f.pWin * 100).toFixed(1)}% · {h.registrations.toLocaleString("en-US")} in</dd><dt>Build</dt><dd>{f.hours}h</dd></dl>
      </div>
      <p className="t-why">{f.repo && <span className="repo">start from {f.repo}</span>}{f.why}</p>
      <div className="t-foot">
        {h.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">Open on {s.source} ↗</a>)}
        <button onClick={onOpen}>Scout's read</button>
        {h.evidence[0] && <button className="q" onClick={() => onEvidence(h.evidence[0])}>{h.evidence[0]}</button>}
      </div>
    </article>
  );
}

function Detail({ f, b, onEvidence, onReport }: { f: Fixture; b: Builder; onEvidence: (q: string, focus?: string) => void; onReport: (f: Fixture, o: "won" | "placed" | "lost") => void }) {
  const h = f.hackathon;
  return (
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
        <p className="ev">{h.evidence.map((q) => <button key={q} onClick={() => onEvidence(q, h.name)}>{q}</button>)}{b.evidence.slice(0, 1).map((q) => <button key={q} onClick={() => onEvidence(q)}>{q}</button>)}</p>
        <div className="acts">
          {h.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">Open on {s.source} ↗</a>)}
          <span className="mono">After it closes:</span>
          <button onClick={() => onReport(f, "won")}>Won</button><button onClick={() => onReport(f, "placed")}>Placed</button><button onClick={() => onReport(f, "lost")}>Didn't place</button>
        </div>
      </div>
    </div>
  );
}
