// Registers Docket Scout's live data estate in Zetaris: Devpost, Devfolio and
// FX as Lightning REST tables (CACHE TABLE'd), and the `scout` views over
// them. Builders' GitHub tables are registered at run time by the Surveyor.
// Runs one statement at a time, as Zetaris requires; "already exists" is done.
//
//   npx tsx --env-file=.env scripts/zetaris-setup.ts
//   --dry-run    print the statements only
//   --refresh    re-fetch every live source (UNCACHE + CACHE), e.g. after a Zetaris restart

import { ZetarisClient, type ZetarisError } from "../src/adapters/zetaris.ts";
import { CONTAINER, VIEWS, zetarisDdl, zetarisRecache } from "../src/sources.ts";

const statements = process.argv.includes("--refresh") ? zetarisRecache() : zetarisDdl();
if (process.argv.includes("--dry-run")) {
  for (const s of statements) console.log(s + ";\n");
  process.exit(0);
}

const z = new ZetarisClient(undefined, false);
if (z.mode !== "live") {
  console.error("ZETARIS_API_KEY is not set (or SAMPLE_MODE=true); nothing to register.");
  process.exit(1);
}

for (const sql of statements) {
  const label = sql.slice(0, 100);
  try {
    await z.run(sql);
    console.log(`PASS  ${label}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/already exist/i.test(msg)) console.log(`SKIP  ${label}  (already exists)`);
    else {
      console.log(`FAIL  ${label}\n      ${msg.slice(0, 300)}`);
      if ((e as ZetarisError).kind === "auth") process.exit(1);
    }
  }
}

for (const v of VIEWS) {
  const started = Date.now();
  try {
    const r = await z.run(`SELECT COUNT(*) AS n FROM ${CONTAINER}.${v.name}`);
    console.log(`ROWS  ${CONTAINER}.${v.name}: ${r.rows[0]?.[0]}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.log(`FAIL  ${CONTAINER}.${v.name}: ${(e as Error).message.slice(0, 200)}`);
  }
}
