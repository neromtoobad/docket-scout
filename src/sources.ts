// The data estate Docket Scout reads through Zetaris. One definition drives
// the Zetaris registration DDL (scripts/zetaris-setup.ts and the Surveyor's
// runtime registration), the local sample-mode mirror (src/adapters/mirror.ts),
// and the schema text the agents see.
//
// Every source is real and live:
//  - Devpost: open and upcoming hackathons (public JSON API, two pages of 40).
//  - Devfolio: hackathons open for applications (public search API, a POST).
//  - open.er-api.com: today's USD exchange rates, so prizes in ₹/€/£ compare.
//  - GitHub: a builder's public repos and profile README. These are registered
//    at run time, per builder, by the Surveyor: the scout extends its own
//    data estate when someone new asks to be scouted.
//
// Agents only query the flattened views in the `scout` container. Zetaris
// builds them with Spark SQL; the mirror builds the same views in DuckDB from
// snapshot files in data/sources, so the agents' SQL runs unchanged offline.

export const CONTAINER = "scout";
export const LIVE_DB = "SCOUT_LIVE";
export const USERS_DB = "SCOUT_USERS";
export const UA = "DocketScout/0.1 (+https://github.com/neromtoobad/docket-scout)";

export interface RawSource {
  table: string;           // raw Lightning REST table name in LIVE_DB
  system: string;
  endpoint: string;
  method: "get" | "post";
  body?: Record<string, string>;
  file: string;            // snapshot file in data/sources for the mirror
}

export const RAW_SOURCES: RawSource[] = [
  { table: "devpost_open_p1", system: "Devpost", endpoint: "https://devpost.com/api/hackathons?status[]=open&per_page=40&page=1", method: "get", file: "devpost_open_p1.json" },
  { table: "devpost_open_p2", system: "Devpost", endpoint: "https://devpost.com/api/hackathons?status[]=open&per_page=40&page=2", method: "get", file: "devpost_open_p2.json" },
  { table: "devpost_upcoming", system: "Devpost", endpoint: "https://devpost.com/api/hackathons?status[]=upcoming&per_page=40&page=1", method: "get", file: "devpost_upcoming.json" },
  { table: "devfolio_open2", system: "Devfolio", endpoint: "https://api.devfolio.co/api/search/hackathons", method: "post", body: { type: "application_open", from: "0", size: "50" }, file: "devfolio_open.json" },
  { table: "fx_usd", system: "open.er-api.com", endpoint: "https://open.er-api.com/v6/latest/USD", method: "get", file: "fx_usd.json" },
];

export interface View {
  name: string;
  desc: string;
  columns: [string, string][]; // name, meaning
}

const HACK_COLUMNS: [string, string][] = [
  ["source", "Devpost | Devfolio"],
  ["source_id", "id on that platform"],
  ["name", "hackathon name"],
  ["url", "page on the platform"],
  ["organizer", "organizer or host"],
  ["online", "1 if online, 0 if in person"],
  ["location", "city/country or 'Online'"],
  ["dates_text", "submission period as the platform shows it (Devpost)"],
  ["starts_at", "ISO start (Devfolio)"],
  ["ends_at", "ISO end (Devfolio)"],
  ["prize_text", "prize as shown, any currency"],
  ["prize_currency", "USD | INR | EUR | GBP"],
  ["prize_amount", "prize in its own currency"],
  ["registrations", "people registered so far"],
  ["themes", "comma-separated themes"],
  ["invite_only", "1 if invite only"],
  ["state", "open | upcoming"],
];

export const VIEWS: View[] = [
  { name: "hackathons", desc: "every live hackathon from Devpost and Devfolio, one shape", columns: HACK_COLUMNS },
  { name: "fx", desc: "USD exchange rates today (units of currency per 1 USD)", columns: [["INR", "rupees per USD"], ["EUR", "euros per USD"], ["GBP", "pounds per USD"], ["NGN", "naira per USD"], ["updated", "rate timestamp"]] },
];

export const REPO_COLUMNS: [string, string][] = [
  ["name", "repo name"], ["language", "main language"], ["description", "repo description"], ["topics", "comma-separated topics"],
  ["stars", "stargazers"], ["is_fork", "1 if a fork"], ["pushed_at", "last push ISO"], ["created_at", "created ISO"], ["homepage", "live link"],
];

export function schemaText(login?: string): string {
  const views = VIEWS.map((v) => `${CONTAINER}.${v.name}  -- ${v.desc}\n` + v.columns.map(([c, d]) => `   ${c}  -- ${d}`).join("\n"));
  if (login) views.push(`${CONTAINER}.${repoView(login)}  -- ${login}'s public GitHub repos (registered at run time)\n` + REPO_COLUMNS.map(([c, d]) => `   ${c}  -- ${d}`).join("\n"));
  return views.join("\n");
}

// ---------------------------------------------------------------- builders

export const safeLogin = (login: string): string => login.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 39);
const ident = (login: string) => safeLogin(login).replace(/-/g, "_");
export const repoView = (login: string) => `repos_${ident(login)}`;
export const readmeView = (login: string) => `readme_${ident(login)}`;
export const repoRaw = (login: string) => `gh_${ident(login)}_repos`;
export const readmeRaw = (login: string) => `gh_${ident(login)}_readme`;

// Statements the Surveyor runs when a new builder is scouted.
export function builderDdl(login: string): string[] {
  const l = safeLogin(login);
  return [
    restTable(USERS_DB, repoRaw(l), `https://api.github.com/users/${l}/repos?per_page=100&sort=pushed`, "get", { "user-agent": UA, accept: "application/vnd.github+json" }),
    `CACHE TABLE ${USERS_DB.toLowerCase()}.${repoRaw(l)}`,
    `CREATE SCHEMASTORE VIEW ${repoView(l)} WITH CONTAINER ${CONTAINER} AS SELECT name, CAST(language AS STRING) AS language, CAST(description AS STRING) AS description, concat_ws(',', topics) AS topics, CAST(stargazers_count AS BIGINT) AS stars, CASE WHEN fork THEN 1 ELSE 0 END AS is_fork, pushed_at, created_at, CAST(homepage AS STRING) AS homepage FROM ${USERS_DB.toLowerCase()}.${repoRaw(l)}`,
    restTable(USERS_DB, readmeRaw(l), `https://api.github.com/repos/${l}/${l}/readme`, "get", { "user-agent": UA, accept: "application/vnd.github+json" }),
    `CACHE TABLE ${USERS_DB.toLowerCase()}.${readmeRaw(l)}`,
    `CREATE SCHEMASTORE VIEW ${readmeView(l)} WITH CONTAINER ${CONTAINER} AS SELECT path, encoding, content FROM ${USERS_DB.toLowerCase()}.${readmeRaw(l)}`,
  ];
}

// ---------------------------------------------------------------- Zetaris DDL

function restTable(db: string, table: string, endpoint: string, method: "get" | "post", headers: Record<string, string>, body: Record<string, string> = {}, enc = "URLENCODED"): string {
  const h = Object.entries(headers).map(([k, v]) => `${k} "${v}"`).join(", ");
  const b = Object.entries(body).map(([k, v]) => `${k} "${v}"`).join(", ");
  return `CREATE LIGHTNING REST TABLE ${table} FROM ${db} REQUEST(endpoint "${endpoint}", method "${method}", response_type "json", http_encoding "${enc}") HEADER (${h}) BODY (${b})`;
}

const live = (t: string) => `${LIVE_DB.toLowerCase()}.${t}`;

// Prize text like "$<span …>50,000</span>" or "₹ 500,000" -> currency + amount (Spark SQL).
const prizeSpark = (x: string) => ({
  text: `trim(regexp_replace(${x}, '<[^>]+>', ''))`,
  currency: `CASE WHEN ${x} LIKE '%₹%' THEN 'INR' WHEN ${x} LIKE '%€%' THEN 'EUR' WHEN ${x} LIKE '%£%' THEN 'GBP' ELSE 'USD' END`,
  amount: `CAST(NULLIF(regexp_replace(regexp_replace(${x}, '<[^>]+>', ''), '[^0-9]', ''), '') AS DOUBLE)`,
});

function devpostSpark(table: string, state: string): string {
  const p = prizeSpark("h.prize_amount");
  return `SELECT 'Devpost' AS source, CAST(h.id AS STRING) AS source_id, h.title AS name, h.url AS url, h.organization_name AS organizer, CASE WHEN h.displayed_location.location = 'Online' THEN 1 ELSE 0 END AS online, h.displayed_location.location AS location, h.submission_period_dates AS dates_text, CAST(NULL AS STRING) AS starts_at, CAST(NULL AS STRING) AS ends_at, ${p.text} AS prize_text, ${p.currency} AS prize_currency, ${p.amount} AS prize_amount, CAST(h.registrations_count AS BIGINT) AS registrations, concat_ws(', ', transform(h.themes, t -> t.name)) AS themes, CASE WHEN h.invite_only THEN 1 ELSE 0 END AS invite_only, '${state}' AS state FROM ${live(table)} LATERAL VIEW explode(hackathons) AS h`;
}

const devfolioSpark = `SELECT 'Devfolio' AS source, CAST(h._source.uuid AS STRING) AS source_id, h._source.name AS name, concat('https://', h._source.slug, '.devfolio.co') AS url, CAST(NULL AS STRING) AS organizer, CASE WHEN h._source.is_online THEN 1 ELSE 0 END AS online, CASE WHEN h._source.is_online THEN 'Online' ELSE concat_ws(', ', h._source.city, h._source.country) END AS location, CAST(NULL AS STRING) AS dates_text, h._source.starts_at AS starts_at, h._source.ends_at AS ends_at, CAST(NULL AS STRING) AS prize_text, 'USD' AS prize_currency, CAST(NULL AS DOUBLE) AS prize_amount, CAST(h._source.participants_count AS BIGINT) AS registrations, concat_ws(', ', transform(h._source.themes, t -> t.name)) AS themes, 0 AS invite_only, 'open' AS state FROM ${live("devfolio_open2")} LATERAL VIEW explode(hits.hits) AS h`;

export function zetarisDdl(): string[] {
  const out = [
    `CREATE LIGHTNING DATABASE ${LIVE_DB} DESCRIBE BY "Live hackathon platforms and FX rates for Docket Scout"`,
    `CREATE LIGHTNING DATABASE ${USERS_DB} DESCRIBE BY "Builders GitHub profiles, registered at run time by the Surveyor"`,
    `CREATE SCHEMASTORE CONTAINER ${CONTAINER}`,
  ];
  for (const s of RAW_SOURCES) {
    const headers: Record<string, string> = s.method === "post" ? { "content-type": "application/json" } : { "user-agent": UA, accept: "application/json" };
    out.push(restTable(LIVE_DB, s.table, s.endpoint, s.method, headers, s.body, s.method === "post" ? "JSON" : "URLENCODED"), `CACHE TABLE ${live(s.table)}`);
  }
  out.push(
    `CREATE SCHEMASTORE VIEW hackathons WITH CONTAINER ${CONTAINER} AS ${devpostSpark("devpost_open_p1", "open")} UNION ALL ${devpostSpark("devpost_open_p2", "open")} UNION ALL ${devpostSpark("devpost_upcoming", "upcoming")} UNION ALL ${devfolioSpark}`,
    `CREATE SCHEMASTORE VIEW fx WITH CONTAINER ${CONTAINER} AS SELECT CAST(rates.INR AS DOUBLE) AS INR, CAST(rates.EUR AS DOUBLE) AS EUR, CAST(rates.GBP AS DOUBLE) AS GBP, CAST(rates.NGN AS DOUBLE) AS NGN, time_last_update_utc AS updated FROM ${live("fx_usd")}`
  );
  return out;
}

// Rebuild the views (after a source table is re-registered under a new name).
export function zetarisRebuildViews(): string[] {
  const ddl = zetarisDdl();
  return [...VIEWS.map((v) => `DROP VIEW ${CONTAINER}.${v.name}`), ...ddl.filter((x) => x.startsWith("CREATE SCHEMASTORE VIEW"))];
}

// Statements to re-run after Zetaris restarts (CACHE TABLE is in-memory), and to refresh live data.
export function zetarisRecache(): string[] {
  return RAW_SOURCES.flatMap((s) => [`UNCACHE TABLE IF EXISTS ${live(s.table)}`, `CACHE TABLE ${live(s.table)}`]);
}

// ---------------------------------------------------------------- DuckDB mirror (same views)

const prizeDuck = (x: string) => ({
  text: `trim(regexp_replace(${x}, '<[^>]+>', '', 'g'))`,
  currency: `CASE WHEN ${x} LIKE '%₹%' THEN 'INR' WHEN ${x} LIKE '%€%' THEN 'EUR' WHEN ${x} LIKE '%£%' THEN 'GBP' ELSE 'USD' END`,
  amount: `TRY_CAST(NULLIF(regexp_replace(regexp_replace(${x}, '<[^>]+>', '', 'g'), '[^0-9]', '', 'g'), '') AS DOUBLE)`,
});

export function mirrorViews(file: (name: string) => string, builders: string[]): string[] {
  const dp = (f: string, state: string) => {
    const p = prizeDuck("h.prize_amount");
    return `SELECT 'Devpost' AS source, CAST(h.id AS VARCHAR) AS source_id, h.title AS name, h.url AS url, h.organization_name AS organizer, CASE WHEN h.displayed_location.location = 'Online' THEN 1 ELSE 0 END AS online, h.displayed_location.location AS location, h.submission_period_dates AS dates_text, CAST(NULL AS VARCHAR) AS starts_at, CAST(NULL AS VARCHAR) AS ends_at, ${p.text} AS prize_text, ${p.currency} AS prize_currency, ${p.amount} AS prize_amount, CAST(h.registrations_count AS BIGINT) AS registrations, array_to_string(list_transform(h.themes, t -> t.name), ', ') AS themes, CASE WHEN h.invite_only THEN 1 ELSE 0 END AS invite_only, '${state}' AS state FROM (SELECT unnest(hackathons) AS h FROM read_json('${file(f)}', maximum_object_size=67108864))`;
  };
  const df = `SELECT 'Devfolio' AS source, CAST(h._source.uuid AS VARCHAR) AS source_id, h._source.name AS name, 'https://' || h._source.slug || '.devfolio.co' AS url, CAST(NULL AS VARCHAR) AS organizer, CASE WHEN h._source.is_online THEN 1 ELSE 0 END AS online, CASE WHEN h._source.is_online THEN 'Online' ELSE concat_ws(', ', h._source.city, h._source.country) END AS location, CAST(NULL AS VARCHAR) AS dates_text, CAST(h._source.starts_at AS VARCHAR) AS starts_at, CAST(h._source.ends_at AS VARCHAR) AS ends_at, CAST(NULL AS VARCHAR) AS prize_text, 'USD' AS prize_currency, CAST(NULL AS DOUBLE) AS prize_amount, CAST(h._source.participants_count AS BIGINT) AS registrations, array_to_string(list_transform(h._source.themes, t -> t.name), ', ') AS themes, 0 AS invite_only, 'open' AS state FROM (SELECT unnest(hits.hits) AS h FROM read_json('${file("devfolio_open.json")}', maximum_object_size=67108864))`;
  const out = [
    `CREATE VIEW ${CONTAINER}.hackathons AS ${dp("devpost_open_p1.json", "open")} UNION ALL ${dp("devpost_open_p2.json", "open")} UNION ALL ${dp("devpost_upcoming.json", "upcoming")} UNION ALL ${df}`,
    `CREATE VIEW ${CONTAINER}.fx AS SELECT CAST(rates.INR AS DOUBLE) AS INR, CAST(rates.EUR AS DOUBLE) AS EUR, CAST(rates.GBP AS DOUBLE) AS GBP, CAST(rates.NGN AS DOUBLE) AS NGN, time_last_update_utc AS updated FROM read_json('${file("fx_usd.json")}')`,
  ];
  for (const l of builders) {
    out.push(
      `CREATE VIEW ${CONTAINER}.${repoView(l)} AS SELECT name, CAST(language AS VARCHAR) AS language, CAST(description AS VARCHAR) AS description, array_to_string(CAST(topics AS VARCHAR[]), ',') AS topics, CAST(stargazers_count AS BIGINT) AS stars, CASE WHEN fork THEN 1 ELSE 0 END AS is_fork, CAST(pushed_at AS VARCHAR) AS pushed_at, CAST(created_at AS VARCHAR) AS created_at, CAST(homepage AS VARCHAR) AS homepage FROM read_json('${file(`github/${safeLogin(l)}.repos.json`)}', maximum_object_size=67108864)`,
      `CREATE VIEW ${CONTAINER}.${readmeView(l)} AS SELECT path, encoding, content FROM read_json('${file(`github/${safeLogin(l)}.readme.json`)}')`
    );
  }
  return out;
}
