// ─── Coinbase Advanced Trade client (CDP API keys, ES256 JWT) ───
// Public market data needs no key. Account + order endpoints use the CDP key
// from env (never stored in the DB, never sent to a browser):
//   COINBASE_API_KEY_NAME     organizations/{org}/apiKeys/{id}
//   COINBASE_API_PRIVATE_KEY  the EC private key PEM ("\n" escapes are accepted)

import crypto from "node:crypto";

const BASE = (process.env.COINBASE_API_BASE || "https://api.coinbase.com").replace(/\/$/, "");
const HOST = new URL(BASE).host;

const num = (v: string | undefined, d: number) => {
  const n = parseFloat(v ?? "");
  return isFinite(n) && n > 0 ? n : d;
};

const keyName = () => (process.env.COINBASE_API_KEY_NAME ?? "").trim();
const privateKey = () => (process.env.COINBASE_API_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();

export const cbConfigured = () => keyName().length > 0 && privateKey().length > 0;

/** every condition that must hold before a single real order can be placed */
export function liveGate(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!cbConfigured()) problems.push("COINBASE_API_KEY_NAME / COINBASE_API_PRIVATE_KEY not set");
  if (process.env.LIVE_TRADING_ENABLED !== "true") problems.push("LIVE_TRADING_ENABLED is not 'true'");
  if (!(process.env.APP_PASSWORD ?? "").trim()) problems.push("APP_PASSWORD not set (dashboard login is required for live trading)");
  return { ok: problems.length === 0, problems };
}

export const liveLimits = () => ({
  bankrollCap: num(process.env.LIVE_BANKROLL_USD, 100), // bot never manages more than this
  maxOrderUsd: num(process.env.LIVE_MAX_ORDER_USD, 25), // hard cap per buy order
});

// ───────────── auth + transport ─────────────

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function makeJwt(method: string, path: string): string {
  const name = keyName();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: name, nonce: crypto.randomBytes(16).toString("hex"), typ: "JWT" };
  const payload = { sub: name, iss: "cdp", nbf: now, exp: now + 120, uri: `${method} ${HOST}${path}` };
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = crypto.sign("sha256", Buffer.from(data), { key: privateKey(), dsaEncoding: "ieee-p1363" });
  return `${data}.${b64u(sig)}`;
}

export class CbError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  o: { query?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (o.auth) {
    if (!cbConfigured()) throw new CbError("coinbase credentials not configured");
    headers.Authorization = `Bearer ${makeJwt(method, path)}`; // uri claim excludes the query string
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${BASE}${path}${o.query ? `?${o.query}` : ""}`, {
      method,
      headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      const j = json as { message?: string; error?: string } | null;
      throw new CbError(`coinbase ${res.status}: ${j?.message ?? j?.error ?? text.slice(0, 120)}`, res.status);
    }
    return json as T;
  } catch (e) {
    if (e instanceof CbError) throw e;
    throw new CbError(`coinbase request failed: ${e instanceof Error ? e.message : "network"}`);
  } finally {
    clearTimeout(t);
  }
}

// ───────────── public market data ─────────────

export interface CbProduct {
  id: string;
  price: number;
  change24h: number; // %
  quoteVolume24h: number; // USD
  baseIncrement: string;
  quoteIncrement: string;
  baseMin: number;
  quoteMin: number;
  tradable: boolean;
}

interface RawProduct {
  product_id: string;
  price: string;
  price_percentage_change_24h: string;
  approximate_quote_24h_volume: string;
  base_increment: string;
  quote_increment: string;
  base_min_size: string;
  quote_min_size: string;
  status: string;
  trading_disabled: boolean;
  is_disabled: boolean;
  view_only?: boolean;
  limit_only?: boolean;
  cancel_only?: boolean;
}

const prodCache = new Map<string, { at: number; data: CbProduct[] }>();

export async function cbProducts(ids: string[], maxAgeMs = 12_000): Promise<CbProduct[]> {
  const key = [...ids].sort().join(",");
  const hit = prodCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
  const q = ids.map((i) => `product_ids=${encodeURIComponent(i)}`).join("&");
  const res = await request<{ products?: RawProduct[] }>("GET", "/api/v3/brokerage/market/products", { query: q });
  const data = (res.products ?? []).map((p) => ({
    id: p.product_id,
    price: parseFloat(p.price),
    change24h: parseFloat(p.price_percentage_change_24h) || 0,
    quoteVolume24h: parseFloat(p.approximate_quote_24h_volume) || 0,
    baseIncrement: p.base_increment,
    quoteIncrement: p.quote_increment,
    baseMin: parseFloat(p.base_min_size) || 0,
    quoteMin: parseFloat(p.quote_min_size) || 0,
    tradable:
      p.status === "online" && !p.trading_disabled && !p.is_disabled && !p.view_only && !p.limit_only && !p.cancel_only,
  })).filter((p) => isFinite(p.price) && p.price > 0);
  prodCache.set(key, { at: Date.now(), data });
  return data;
}

export interface CbCandle { t: number; o: number; h: number; l: number; c: number; v: number }

export async function cbCandles(id: string, granularity: "ONE_MINUTE" | "ONE_HOUR", count: number): Promise<CbCandle[]> {
  const step = granularity === "ONE_MINUTE" ? 60 : 3600;
  const end = Math.floor(Date.now() / 1000);
  const res = await request<{ candles?: { start: string; low: string; high: string; open: string; close: string; volume: string }[] }>(
    "GET",
    `/api/v3/brokerage/market/products/${id}/candles`,
    { query: `start=${end - step * count}&end=${end}&granularity=${granularity}&limit=${count}` }
  );
  return (res.candles ?? [])
    .map((c) => ({ t: Number(c.start) * 1000, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume }))
    .filter((c) => [c.o, c.h, c.l, c.c].every((x) => isFinite(x) && x > 0))
    .sort((a, b) => a.t - b.t); // API returns newest first
}

// internal symbols keep the legacy "BTCUSDT" shape; Coinbase trades BTC-USD
export const toProductId = (symbol: string) => `${symbol.replace(/USDT$/, "")}-USD`;

// ───────────── account (needs key) ─────────────

export interface CbBalance { currency: string; available: number; hold: number }

export async function cbAccounts(): Promise<CbBalance[]> {
  const out: CbBalance[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const res = await request<{
      accounts?: { currency: string; available_balance: { value: string }; hold?: { value: string } }[];
      has_next?: boolean;
      cursor?: string;
    }>("GET", "/api/v3/brokerage/accounts", { auth: true, query: `limit=250${cursor ? `&cursor=${cursor}` : ""}` });
    for (const a of res.accounts ?? []) {
      const available = parseFloat(a.available_balance?.value ?? "0") || 0;
      const hold = parseFloat(a.hold?.value ?? "0") || 0;
      if (available > 0 || hold > 0) out.push({ currency: a.currency, available, hold });
    }
    if (!res.has_next || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

// ───────────── orders (needs key) ─────────────

export interface CbFill {
  orderId: string;
  filledSize: number; // base units
  grossUsd: number; // filled_value
  feesUsd: number;
  avgPrice: number;
}

const decimalsOf = (inc: string) => (inc.includes(".") ? inc.replace(/0+$/, "").split(".")[1]?.length ?? 0 : 0);

/** round DOWN to an exchange increment, returned as a string with the right precision */
export function floorTo(x: number, inc: string): string {
  const step = parseFloat(inc);
  if (!isFinite(step) || step <= 0) return String(x);
  return (Math.floor(x / step + 1e-9) * step).toFixed(decimalsOf(inc));
}

interface RawOrder {
  order_id: string;
  client_order_id?: string;
  status: string;
  filled_size?: string;
  filled_value?: string;
  average_filled_price?: string;
  total_fees?: string;
}

const toFill = (o: RawOrder): CbFill => {
  const filledSize = parseFloat(o.filled_size ?? "0") || 0;
  const grossUsd = parseFloat(o.filled_value ?? "0") || 0;
  return {
    orderId: o.order_id,
    filledSize,
    grossUsd,
    feesUsd: parseFloat(o.total_fees ?? "0") || 0,
    avgPrice: parseFloat(o.average_filled_price ?? "0") || (filledSize > 0 ? grossUsd / filledSize : 0),
  };
};

async function awaitFill(orderId: string): Promise<CbFill> {
  let last: RawOrder | null = null;
  for (let i = 0; i < 20; i++) {
    const res = await request<{ order?: RawOrder }>("GET", `/api/v3/brokerage/orders/historical/${orderId}`, { auth: true });
    last = res.order ?? null;
    if (last && ["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(last.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!last) throw new CbError("order status unavailable");
  const fill = toFill(last);
  if (fill.filledSize <= 0) throw new CbError(`order ${last.status.toLowerCase()} with no fill`);
  return fill;
}

/** look for an order we may have submitted when the POST response never arrived */
async function recoverByClientId(clientId: string, productId: string): Promise<CbFill | null> {
  try {
    const res = await request<{ orders?: RawOrder[] }>("GET", "/api/v3/brokerage/orders/historical/batch", {
      auth: true,
      query: `product_ids=${productId}&limit=20`,
    });
    const o = (res.orders ?? []).find((x) => x.client_order_id === clientId);
    return o ? awaitFill(o.order_id) : null;
  } catch {
    return null;
  }
}

export async function cbMarketOrder(
  productId: string,
  side: "BUY" | "SELL",
  size: { quoteUsd: number; quoteInc: string } | { baseQty: number; baseInc: string }
): Promise<CbFill> {
  const clientId = crypto.randomUUID();
  const config =
    "quoteUsd" in size
      ? { quote_size: floorTo(size.quoteUsd, size.quoteInc) }
      : { base_size: floorTo(size.baseQty, size.baseInc) };
  type Resp = {
    success?: boolean;
    success_response?: { order_id: string };
    error_response?: { error?: string; message?: string; error_details?: string };
  };
  let res: Resp;
  try {
    res = await request<Resp>("POST", "/api/v3/brokerage/orders", {
      auth: true,
      timeoutMs: 10_000,
      body: { client_order_id: clientId, product_id: productId, side, order_configuration: { market_market_ioc: config } },
    });
  } catch (e) {
    if (e instanceof CbError && e.status >= 400 && e.status < 500) throw e; // rejected outright
    const recovered = await recoverByClientId(clientId, productId); // network / 5xx: did it land?
    if (recovered) return recovered;
    throw e;
  }
  if (!res.success || !res.success_response?.order_id) {
    const er = res.error_response;
    throw new CbError(`order rejected: ${er?.message || er?.error_details || er?.error || "unknown"}`);
  }
  return awaitFill(res.success_response.order_id);
}
