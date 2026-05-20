import pg from "pg";

// Idempotent schema bootstrap — runs CREATE TABLE IF NOT EXISTS for every
// application table. Safe to call on every startup; instant when tables exist.
// Matches shared/schema.ts exactly.
const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password text,
  name text NOT NULL DEFAULT '',
  sender_name text,
  stripe_customer_id text,
  stripe_subscription_id text,
  trial_started_at timestamp,
  is_subscribed boolean NOT NULL DEFAULT false,
  hw_credits integer NOT NULL DEFAULT 10,
  hw_credits_reset_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folders (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id),
  name text NOT NULL,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id),
  name text NOT NULL,
  email text,
  phone text,
  notes text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES users(id),
  folder_id varchar REFERENCES folders(id),
  client_id varchar REFERENCES clients(id),
  name text NOT NULL,
  type text NOT NULL DEFAULT 'pdf',
  data_url text NOT NULL,
  pages text NOT NULL DEFAULT '[]',
  size integer NOT NULL DEFAULT 0,
  thumb_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  notes text,
  is_favorite boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_events (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id varchar NOT NULL REFERENCES documents(id),
  user_id varchar NOT NULL REFERENCES users(id),
  type text NOT NULL,
  label text NOT NULL DEFAULT '',
  created_at timestamp DEFAULT now()
);
`;

export async function ensureSchema(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(SQL);
    console.log("[schema] All tables verified/created");
  } catch (err) {
    console.error("[schema] Failed to ensure schema:", err);
    throw err;
  } finally {
    await client.end();
  }
}
