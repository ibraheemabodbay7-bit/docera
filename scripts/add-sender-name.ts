import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS sender_name text");
  console.log("✓ sender_name column added");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
