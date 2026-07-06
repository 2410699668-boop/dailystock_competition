import { getHistory, normalizeIdentity } from "../lib/market.mjs";

export default async request => {
  const url = new URL(request.url);
  try {
    const identity = normalizeIdentity(url.searchParams.get("code"), url.searchParams.get("market"));
    const limit = Math.max(10, Math.min(Number(url.searchParams.get("limit") || 420), 1000));
    const data = await getHistory(identity, url.searchParams.get("start"), url.searchParams.get("end"), limit);
    return Response.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message || "历史行情查询失败" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};

export const config = { path: "/api/history" };
