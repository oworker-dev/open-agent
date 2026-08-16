import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const connectionString = process.env.AGENT_DATABASE_URL?.trim();
if (!connectionString) throw new Error("AGENT_DATABASE_URL is required.");

const schema = process.env.AGENT_DATABASE_SCHEMA?.trim() || "open_agent";
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
  throw new Error("AGENT_DATABASE_SCHEMA must be a valid PostgreSQL identifier.");
}

const pool = new pg.Pool({ application_name: "open-agent-migrate", connectionString, max: 1 });

try {
  const migrationsUrl = new URL("../server/data/migrations/", import.meta.url);
  const migrationsDirectory = fileURLToPath(migrationsUrl);
  const migrations = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/u.test(file))
    .sort();
  if (migrations.length === 0) throw new Error("No Agent data migrations were found.");
  for (const migration of migrations) {
    const source = await readFile(new URL(migration, migrationsUrl), "utf8");
    await pool.query(source.replaceAll("__AGENT_SCHEMA__", schema));
    console.log(`Applied ${migration}.`);
  }
  console.log(`Agent data schema ${schema} is ready.`);
} finally {
  await pool.end();
}
