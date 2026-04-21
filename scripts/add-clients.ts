import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      email text,
      phone text,
      notes text,
      created_at timestamp DEFAULT now()
    )
  `);
  console.log("✓ clients table created");

  await pool.query(
    "ALTER TABLE documents ADD COLUMN IF NOT EXISTS client_id varchar REFERENCES clients(id) ON DELETE SET NULL"
  );
  console.log("✓ client_id column added to documents");

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
