// Saves today's responses from the same live endpoints Zetaris reads into
// data/sources, for the offline mirror (SAMPLE_MODE). Optionally also saves
// GitHub snapshots for the builders named on the command line.
//   npx tsx scripts/snapshot.ts [login ...]

import { mkdirSync, writeFileSync } from "node:fs";
import { RAW_SOURCES, UA, safeLogin } from "../src/sources.ts";

mkdirSync("data/sources/github", { recursive: true });
for (const s of RAW_SOURCES) {
  const res = await fetch(s.endpoint, s.method === "post"
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(Object.entries(s.body ?? {}).map(([k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v]))) }
    : { headers: { "user-agent": UA, accept: "application/json" } });
  const text = await res.text();
  writeFileSync(`data/sources/${s.file}`, text);
  console.log(`${res.status}  ${s.file}  ${text.length} bytes`);
}
for (const login of process.argv.slice(2).map(safeLogin)) {
  const h = { "user-agent": UA, accept: "application/vnd.github+json" };
  const repos = await fetch(`https://api.github.com/users/${login}/repos?per_page=100&sort=pushed`, { headers: h });
  writeFileSync(`data/sources/github/${login}.repos.json`, await repos.text());
  const readme = await fetch(`https://api.github.com/repos/${login}/${login}/readme`, { headers: h });
  writeFileSync(`data/sources/github/${login}.readme.json`, readme.ok ? await readme.text() : JSON.stringify({ path: "README.md", encoding: "base64", content: "" }));
  console.log(`${repos.status}/${readme.status}  github/${login}`);
}
