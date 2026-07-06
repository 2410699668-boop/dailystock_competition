const AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"
];

export function normalizeIdentity(input, explicitMarket = "") {
  const code = String(input || "").replace(/\D/g, "").slice(-6);
  if (!/^\d{6}$/.test(code)) throw new Error("请输入6位A股代码");
  let market = String(explicitMarket || "").toLowerCase();
  if (!["sh", "sz", "bj"].includes(market)) {
    if (/^(43|83|87|88|92)/.test(code)) market = "bj";
    else if (/^[569]/.test(code)) market = "sh";
    else market = "sz";
  }
  return {
    code,
    market,
    symbol: `${market}${code}`,
    secid: `${market === "sh" ? 1 : 0}.${code}`
  };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function withTimeout(ms = 7500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchBytes(url, { referer = "https://quote.eastmoney.com/", timeout = 7500 } = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const t = withTimeout(timeout);
    try {
      const response = await fetch(url, {
        signal: t.signal,
        headers: {
          "User-Agent": AGENTS[attempt % AGENTS.length],
          "Accept": "application/json,text/plain,*/*",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Referer": referer,
          "Cache-Control": "no-cache"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      last = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 180));
    } finally {
      t.clear();
    }
  }
  throw new Error(last?.name === "AbortError" ? "请求超时" : (last?.message || "网络连接失败"));
}

async function fetchText(url, options = {}) {
  const bytes = await fetchBytes(url, options);
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchGbk(url, options = {}) {
  const bytes = await fetchBytes(url, options);
  return new TextDecoder("gb18030").decode(bytes);
}

function parseJSONP(text) {
  const clean = String(text || "").trim().replace(/^\uFEFF/, "");
  try { return JSON.parse(clean); } catch {}
  const start = clean.indexOf("(");
  const end = clean.lastIndexOf(")");
  if (start >= 0 && end > start) return JSON.parse(clean.slice(start + 1, end));
  const equal = clean.indexOf("=");
  if (equal >= 0) {
    const candidate = clean.slice(equal + 1).trim().replace(/;$/, "");
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error("接口返回格式无法识别");
}

function quoteTimeFromEastmoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const d = new Date(n > 1e12 ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

async function eastmoneyQuote(identity) {
  const fields = "f43,f46,f57,f58,f60,f86,f170,f127,f128";
  const params = new URLSearchParams({
    secid: identity.secid,
    fields,
    fltt: "2",
    invt: "2",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    _: String(Date.now())
  });
  const hosts = ["push2.eastmoney.com", "push2delay.eastmoney.com", "82.push2.eastmoney.com"];
  const errors = [];
  for (const host of hosts) {
    try {
      const payload = parseJSONP(await fetchText(`https://${host}/api/qt/stock/get?${params}`));
      const d = payload?.data;
      if (!d?.f58) throw new Error("无数据");
      return {
        code: String(d.f57 || identity.code),
        name: String(d.f58),
        currentPrice: number(d.f43),
        openPrice: number(d.f46),
        previousClose: number(d.f60),
        changePct: Number.isFinite(Number(d.f170)) ? Number(d.f170) : null,
        sector: d.f127 && d.f127 !== "-" ? String(d.f127) : "",
        sectorCode: d.f128 && d.f128 !== "-" ? String(d.f128) : "",
        quoteTime: quoteTimeFromEastmoney(d.f86),
        provider: `东方财富(${host.split(".")[0]})`
      };
    } catch (error) { errors.push(`${host}: ${error.message}`); }
  }
  throw new Error(errors.join("；"));
}

async function tencentQuote(identity) {
  const text = await fetchGbk(`https://qt.gtimg.cn/q=${identity.symbol}&_=${Date.now()}`, { referer: "https://gu.qq.com/" });
  const match = text.match(/=\s*"([\s\S]*)"\s*;?\s*$/);
  if (!match) throw new Error("返回格式无法识别");
  const f = match[1].split("~");
  if (f.length < 33 || !f[1]) throw new Error("无数据");
  const rawTime = f[30] || "";
  const time = /^\d{14}$/.test(rawTime) ? `${rawTime.slice(0,4)}-${rawTime.slice(4,6)}-${rawTime.slice(6,8)}T${rawTime.slice(8,10)}:${rawTime.slice(10,12)}:${rawTime.slice(12,14)}+08:00` : rawTime;
  return {
    code: f[2] || identity.code,
    name: f[1],
    currentPrice: number(f[3]),
    openPrice: number(f[5]),
    previousClose: number(f[4]),
    changePct: Number.isFinite(Number(f[32])) ? Number(f[32]) : null,
    sector: "",
    sectorCode: "",
    quoteTime: time,
    provider: "腾讯行情"
  };
}

async function sinaQuote(identity) {
  const text = await fetchGbk(`https://hq.sinajs.cn/list=${identity.symbol}&_=${Date.now()}`, { referer: "https://finance.sina.com.cn/" });
  const match = text.match(/=\s*"([\s\S]*)"\s*;?\s*$/);
  if (!match) throw new Error("返回格式无法识别");
  const f = match[1].split(",");
  if (f.length < 32 || !f[0]) throw new Error("无数据");
  const current = number(f[3]);
  const previous = number(f[2]);
  return {
    code: identity.code,
    name: f[0],
    currentPrice: current,
    openPrice: number(f[1]),
    previousClose: previous,
    changePct: current && previous ? (current / previous - 1) * 100 : null,
    sector: "",
    sectorCode: "",
    quoteTime: `${f[30] || ""}T${f[31] || ""}+08:00`,
    provider: "新浪行情"
  };
}

export async function getQuote(identity) {
  const errors = [];
  for (const [label, fn] of [["东方财富", eastmoneyQuote], ["腾讯", tencentQuote], ["新浪", sinaQuote]]) {
    try { return await fn(identity); }
    catch (error) { errors.push(`${label}: ${error.message}`); }
  }
  throw new Error(errors.join(" | "));
}

function compactDate(value, fallback) {
  const raw = String(value || fallback || "").slice(0, 10);
  return raw.replace(/-/g, "");
}

async function eastmoneyHistory(identity, start, end, limit) {
  const params = new URLSearchParams({
    secid: identity.secid,
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56",
    klt: "101",
    fqt: "0",
    beg: compactDate(start, "19900101"),
    end: compactDate(end, "20500101"),
    lmt: String(Math.max(30, Math.min(limit, 1000))),
    _: String(Date.now())
  });
  const hosts = ["push2his.eastmoney.com", "63.push2his.eastmoney.com", "79.push2his.eastmoney.com"];
  const errors = [];
  for (const host of hosts) {
    try {
      const payload = parseJSONP(await fetchText(`https://${host}/api/qt/stock/kline/get?${params}`));
      const lines = payload?.data?.klines;
      if (!Array.isArray(lines) || !lines.length) throw new Error("无日线数据");
      const rows = lines.map(line => {
        const p = String(line).split(",");
        return { date: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]) };
      }).filter(row => row.date && [row.open,row.close,row.high,row.low].every(Number.isFinite));
      if (!rows.length) throw new Error("日线解析后为空");
      return { rows: rows.slice(-limit), provider: `东方财富日线(${host.split(".")[0]})` };
    } catch (error) { errors.push(`${host}: ${error.message}`); }
  }
  throw new Error(errors.join("；"));
}

async function tencentHistory(identity, start, end, limit) {
  const variable = `q_${Date.now()}`;
  const param = `${identity.symbol},day,${start || "1990-01-01"},${end || "2050-01-01"},${Math.max(30, Math.min(limit, 1000))}`;
  const qs = new URLSearchParams({ _var: variable, param, _: String(Date.now()) });
  const payload = parseJSONP(await fetchText(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?${qs}`, { referer: "https://gu.qq.com/" }));
  const node = payload?.data?.[identity.symbol] || {};
  const source = node.day || node.qfqday || [];
  if (!Array.isArray(source) || !source.length) throw new Error("无日线数据");
  const rows = source.map(p => ({ date: String(p[0]), open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]) }))
    .filter(row => row.date && [row.open,row.close,row.high,row.low].every(Number.isFinite));
  if (!rows.length) throw new Error("日线解析后为空");
  return { rows: rows.slice(-limit), provider: "腾讯日线" };
}

async function sinaHistory(identity, start, end, limit) {
  const qs = new URLSearchParams({ symbol: identity.symbol, scale: "240", ma: "no", datalen: String(Math.max(120, Math.min(limit * 2, 1023))) });
  const payload = JSON.parse(await fetchText(`https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?${qs}`, { referer: "https://finance.sina.com.cn/" }));
  if (!Array.isArray(payload)) throw new Error("无日线数据");
  const rows = payload.map(item => ({
    date: String(item.day || item.date || "").slice(0,10), open: Number(item.open), close: Number(item.close), high: Number(item.high), low: Number(item.low), volume: Number(item.volume || 0)
  })).filter(row => row.date && (!start || row.date >= start) && (!end || row.date <= end) && [row.open,row.close,row.high,row.low].every(Number.isFinite));
  if (!rows.length) throw new Error("日线解析后为空");
  return { rows: rows.slice(-limit), provider: "新浪日线" };
}

export async function getHistory(identity, start, end, limit = 420) {
  const errors = [];
  for (const [label, fn] of [["东方财富", eastmoneyHistory], ["腾讯", tencentHistory], ["新浪", sinaHistory]]) {
    try { return await fn(identity, start, end, limit); }
    catch (error) { errors.push(`${label}: ${error.message}`); }
  }
  throw new Error(errors.join(" | "));
}
