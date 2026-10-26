// Local mirror of the data estate for SAMPLE_MODE and offline judging: the
// same `scout.*` views Zetaris serves, built in an in-process DuckDB from the
// snapshot files in data/sources (taken from the same live endpoints by
// scripts/snapshot.ts), so the agents' SQL runs unchanged. Results are
// labelled source "mirror", never "live".

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CONTAINER, mirrorViews } from "../sources.ts";

let conn: Promise<DuckDBConnection> | null = null;

export const mirrorBuilders = (): string[] =>
  existsSync("data/sources/github") ? readdirSync("data/sources/github").filter((f) => f.endsWith(".repos.json")).map((f) => f.replace(".repos.json", "")) : [];

async function open(): Promise<DuckDBConnection> {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run(`CREATE SCHEMA ${CONTAINER}`);
  const file = (name: string) => resolve("data/sources", name).replace(/'/g, "''");
  for (const sql of mirrorViews(file, mirrorBuilders())) await c.run(sql);
  return c;
}

export async function mirrorQuery(sql: string, limit = 200): Promise<{ columns: string[]; rows: unknown[][] }> {
  conn ??= open();
  const c = await conn;
  // Spark-isms the agents may emit that DuckDB spells differently.
  const portable = sql.replace(/`/g, '"');
  const reader = await c.runAndReadAll(portable);
  const columns = reader.columnNames();
  const rows = reader.getRowsJS().slice(0, limit).map((r) => r.map((v) => (typeof v === "bigint" ? Number(v) : v)));
  return { columns, rows };
}
