# Crease — cricket auction room

A host-controlled live cricket auction for phones and desktop. The React/Vite website connects to an Express and Socket.IO backend. Locally, room data is kept in SQLite. For online hosting, the backend can store room state in Supabase Postgres. Gemini is called only from the backend, so the AI key never goes to browsers.

## Run locally

Requires Node.js 22.5 or newer.

1. Copy `.env.example` to `.env` and add your Gemini API key and model name.
2. Install dependencies with `npm install`.
3. Start both parts with `npm run dev`.
4. Open `http://localhost:5173`.

Leave `VITE_SERVER_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` empty locally. The website uses Vite's local proxy and the backend saves to `auction.sqlite`.

## Free online setup

This split keeps the browser, real-time auction server, and database on separate services. Free plans are suitable for a hobby MVP, but do not promise always-on availability: Render can sleep when idle, and Supabase can pause an inactive free project. A cold start may make the first connection take longer. Gemini API usage also follows Google's current quota and pricing.

### 1. Create the database in Supabase

1. Create a free Supabase project.
2. In its SQL Editor, run the contents of `supabase/rooms-schema.sql`.
3. In Project Settings / API, copy the Project URL and the `service_role` key. Treat the service role key like a password; it belongs only in Render's backend variables.
4. If Render cannot connect to the database, use Supabase's shared pooler connection information and make sure the host is IPv4-compatible.

### 2. Put the backend on Render

Create a **Web Service** from this repository:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Instance: Free

Add these environment variables in Render:

- `NODE_ENV` = `production`
- `AI_API_KEY` = your Gemini API key
- `AI_MODEL` = a Gemini model available to your key
- `SUPABASE_URL` = your Supabase Project URL
- `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service role key
- `CLIENT_ORIGIN` = your Vercel website URL (add the final URL after step 3)

Render assigns `PORT` automatically. Copy the backend's public `https://...onrender.com` URL when its first deploy finishes.

### 3. Put the website on Vercel

Import this same repository as a Vercel project. Vercel should detect Vite; set the build command to `npm run build` and output directory to `dist` if it does not detect them automatically. Add this build environment variable:

- `VITE_SERVER_URL` = the Render backend URL, such as `https://crease-auction.onrender.com`

Deploy the site, then copy its public `https://...vercel.app` URL into Render's `CLIENT_ORIGIN` variable and redeploy the backend. Share the Vercel URL or the room QR with participants. Do not set the Supabase service role key or Gemini API key in Vercel.

### 4. Carry over the existing auction data

Back up `auction.sqlite` first. With the Supabase schema created and the Supabase URL and service role key temporarily set in your local `.env`, run `node scripts/migrate-sqlite-to-supabase.js` once from the project folder. The script imports the rooms from local SQLite. Remove those two credentials from the local `.env` when finished if you do not need them there. New local runs continue using SQLite whenever the Supabase variables are absent.

## MVP flow

- Host creates a room, choosing format, teams, purse, squad size, timer, bid step, player count, and per-role caps.
- Host imports a CSV/TXT player list (one player per line or CSV columns such as name, role, country), or loads the included 100-player ODI pool. Imported players always have a 0 base price; the first accepted bid starts at the room's minimum bid.
- Host shares the room QR or code.
- Captains take a team seat; the host starts the auction after at least two captains join.
- The next available player appears automatically after each player is sold or passed. The server checks bids and saves the room.
- Any team with at least eleven players can request an AI best-XI suggestion.

For real player datasets, use a licensed source and add CSV import before replacing fictional AI-generated names.
