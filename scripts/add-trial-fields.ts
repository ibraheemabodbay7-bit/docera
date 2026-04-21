import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at timestamptz");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_subscribed boolean NOT NULL DEFAULT false");
  console.log("✓ trial_started_at and is_subscribed columns added");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
