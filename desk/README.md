# Amira desk

Local view of `leads` and `messages`. It updates as WhatsApp turns land.

```bash
cd desk
npm install
npm run dev
```

Open http://localhost:5174. Paste the project URL and the **service role** key
(Supabase → Project Settings → API). The store’s Data API is closed to the
anon key, so that key will load nothing. The key stays in this browser’s
localStorage. Do not deploy this app.

You can also put the same values in `desk/.env.local` (gitignored):

```
VITE_SUPABASE_URL=https://tmewbswbhnmuuomdfewq.supabase.co
VITE_SUPABASE_SECRET_KEY=
```
