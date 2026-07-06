export default async () => Response.json({
  ok: true,
  service: "stock-competition-supabase-collab",
  time: new Date().toISOString(),
  database: "Supabase Postgres",
  collaboration: "public-write",
  marketData: "Netlify Functions"
}, { headers: { "Cache-Control": "no-store" } });

export const config = { path: "/api/health" };
