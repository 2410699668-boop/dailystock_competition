import { getQuote, normalizeIdentity } from "../lib/market.mjs";

export default async request => {
  const url = new URL(request.url);
  try {
    const identity = normalizeIdentity(url.searchParams.get("code"), url.searchParams.get("market"));
    const data = await getQuote(identity);
    return Response.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message || "行情查询失败" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};

export const config = { path: "/api/quote" };
