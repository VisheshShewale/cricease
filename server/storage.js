import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
let sqlite;
let remote;

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (Boolean(url) !== Boolean(key)) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or leave both unset to use local SQLite.');
  }
  return url && key ? { url, key } : null;
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${remote.url}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: remote.key,
      authorization: `Bearer ${remote.key}`,
      'content-type': 'application/json',
      ...options.headers
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Supabase storage request failed (${response.status}). Check the rooms table setup and database environment variables.${detail ? ` ${detail.slice(0, 240)}` : ''}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function loadRooms() {
  remote = supabaseConfig();
  if (remote) {
    const rows = await supabaseRequest('rooms?select=code,state');
    return rows.map(row => ({
      code: row.code,
      state: typeof row.state === 'string' ? JSON.parse(row.state) : row.state
    }));
  }
  const dbPath = process.env.LOCAL_SQLITE_PATH || path.join(root, 'auction.sqlite');
  sqlite = new DatabaseSync(dbPath);
  sqlite.exec('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)');
  return sqlite.prepare('SELECT code, state FROM rooms').all().map(row => ({ code: row.code, state: JSON.parse(row.state) }));
}

export async function saveRoom(code, state) {
  if (remote) {
    await supabaseRequest('rooms?on_conflict=code', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ code, state, updated_at: new Date().toISOString() })
    });
    return;
  }
  sqlite.prepare('INSERT INTO rooms(code,state,updated_at) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at')
    .run(code, JSON.stringify(state), new Date().toISOString());
}
