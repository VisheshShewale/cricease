import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env before migrating.');

const dbPath = process.env.LOCAL_SQLITE_PATH || path.join(root, 'auction.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
const rooms = db.prepare('SELECT code, state, updated_at FROM rooms').all();
db.close();

for (const room of rooms) {
  const response = await fetch(`${url}/rest/v1/rooms?on_conflict=code`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ code: room.code, state: JSON.parse(room.state), updated_at: room.updated_at })
  });
  if (!response.ok) {
    console.error(`Could not migrate room ${room.code}: Supabase returned ${response.status}.`);
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) console.log(`Migrated ${rooms.length} room(s) to Supabase.`);
