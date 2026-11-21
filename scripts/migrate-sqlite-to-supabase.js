import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env before migrating.');
let parsedUrl;
try { parsedUrl = new URL(url); } catch {
  throw new Error('SUPABASE_URL is not a valid URL. Replace the example placeholder with the Project URL shown in your Supabase dashboard.');
}
if (parsedUrl.protocol !== 'https:' || /your-supabase-project-url|your-project-url|example\.com/i.test(parsedUrl.hostname)) {
  throw new Error('SUPABASE_URL must be your real HTTPS Supabase Project URL, such as https://<project-ref>.supabase.co. Do not include /rest/v1.');
}

const dbPath = process.env.LOCAL_SQLITE_PATH || path.join(root, 'auction.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
const rooms = db.prepare('SELECT code, state, updated_at FROM rooms').all();
db.close();

for (const room of rooms) {
  const headers = {
    apikey: key,
    'content-type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };
  // New sb_secret_* API keys are not JWTs and must not be sent as Bearer.
  // The legacy service_role key is a JWT and works in both headers.
  if (!key.startsWith('sb_secret_')) headers.authorization = `Bearer ${key}`;
  let response;
  try {
    response = await fetch(`${url}/rest/v1/rooms?on_conflict=code`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: room.code, state: JSON.parse(room.state), updated_at: room.updated_at })
    });
  } catch (error) {
    const code = error?.cause?.code || error?.code || 'network error';
    console.error(`Could not reach Supabase (${code}). Check the Project URL and your DNS/network connection.`);
    process.exitCode = 1;
    break;
  }
  if (!response.ok) {
    console.error(`Could not migrate room ${room.code}: Supabase returned ${response.status}.`);
    if (response.status === 404) {
      console.error('The public.rooms table may be missing, or the Data API may be disabled. Run supabase/rooms-schema.sql in this project’s SQL Editor and confirm Data API is enabled.');
    }
    if (response.status === 401) {
      console.error('Check that SUPABASE_URL and the backend key belong to the same project. Use that project’s secret key (sb_secret_...) or legacy service_role key; do not use a publishable or anon key.');
    }
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) console.log(`Migrated ${rooms.length} room(s) to Supabase.`);
