import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false"
  );
  console.log("✓ is_favorite column added to documents");

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
