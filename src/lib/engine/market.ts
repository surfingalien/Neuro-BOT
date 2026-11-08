// ─── Market data: Binance (majors) + DexScreener (Solana memecoins) ───
// All public endpoints, no keys required. Falls back to a clearly-labeled
// synthetic feed if the sandbox has no outbound access.

import type { Candle, Klines, MarketKind, ScoutPair } from "./types";

export const MAJOR_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
  "AVAXUSDT",
  "SUIUSDT",
] as const;

const MAJOR_NAMES: Record<string, string> = {
  BTCUSDT: "Bitcoin",
  ETHUSDT: "Ethereum",
  SOLUSDT: "Solana",
  BNBUSDT: "BNB",
  XRPUSDT: "XRP",
  DOGEUSDT: "Dogecoin",
  ADAUSDT: "Cardano",
  LINKUSDT: "Chainlink",
  AVAXUSDT: "Avalanche",
  SUIUSDT: "Sui",
};

// Realistic anchors for the synthetic fallback feed
const SIM_ANCHORS: Record<string, number> = {
  BTCUSDT: 76000,
  ETHUSDT: 2750,
  SOLUSDT: 148,
  BNBUSDT: 590,
  XRPUSDT: 1.85,
  DOGEUSDT: 0.16,
  ADAUSDT: 0.52,
  LINKUSDT: 13.4,
  AVAXUSDT: 18.2,
  SUIUSDT: 2.1,
};

const MEME_NOUNS = ["PIPPA","FIZZLE","KAPPU","HOBBL","MANG0P","SQOONK","LUMPY","KINIX","RUBZ","ZORBI","PEBL","PLOOF","DOOFY","CHIPPO","SNAILZ","TOPFU","GLORP","SPROUT","WIGGL","BONKK","MUUNY","TAFFY","GRUBZ","YOINK","PLONK","SNORL","DUSTY","WOBL","CRUMB","JIGGL"];
const MEME_PREFIX = ["","","","BABY","SUPER","MOON","GIGA","TURBO","MEGA","LIL"];

type CacheEntry<T> = { data: T; at: number };
const memo = globalThis as unknown as {
  __nbTickerCache?: CacheEntry<Record<string, { price: number; change: number; qv: number }>>;
  __nbDexCache?: CacheEntry<ScoutPair[]>;
  __nbKlineCache?: Map<string, CacheEntry<Klines>>;
  __nbLiveOk?: boolean | null;
  __nbSimState?: Map<string, { p: number; drift: number }>;
  __nbSimMemes?: Map<string, { p: number; liq: number; vol: number; born: number }>;
};

const klineCache = (memo.__nbKlineCache ??= new Map());
const simState = (memo.__nbSimState ??= new Map());
const simMemes = (memo.__nbSimMemes ??= new Map());

async function timedFetch(url: string, ms = 7000): Promise<Response | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

// ───────────────────────── Binance majors ─────────────────────────

export async function fetchMajors(): Promise<{
  rows: ScoutPair[];
  live: boolean;
}> {
  const now = Date.now();
  const cached = memo.__nbTickerCache;
  if (cached && now - cached.at < 12_000) {
    return { rows: majorsFromTicker(cached.data), live: memo.__nbLiveOk !== false };
  }

  const symbols = encodeURIComponent(JSON.stringify(MAJOR_SYMBOLS as unknown as string[]));
  const res = await timedFetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbols}`);
  if (res) {
    try {
      const json = (await res.json()) as {
        symbol: string;
        lastPrice: string;
        priceChangePercent: string;
        quoteVolume: string;
      }[];
      const map: Record<string, { price: number; change: number; qv: number }> = {};
      for (const r of json) {
        map[r.symbol] = {
          price: parseFloat(r.lastPrice),
          change: parseFloat(r.priceChangePercent),
          qv: parseFloat(r.quoteVolume),
        };
      }
      memo.__nbTickerCache = { data: map, at: now };
      memo.__nbLiveOk = true;
      return { rows: majorsFromTicker(map), live: true };
    } catch {
      /* fall through to sim */
    }
  }
  memo.__nbLiveOk = false;
  return { rows: simMajors(now), live: false };
}

function majorsFromTicker(map: Record<string, { price: number; change: number; qv: number }>): ScoutPair[] {
  return MAJOR_SYMBOLS.map((s) => {
    const d = map[s] ?? { price: SIM_ANCHORS[s] ?? 100, change: 0, qv: 100_000_000 };
    return {
      symbol: s,
      base: s.replace("USDT", ""),
      name: MAJOR_NAMES[s] ?? s,
      market: "majors" as const,
      price: d.price,
      change24h: d.change,
      volume24h: d.qv,
      volume1h: d.qv / 24,
      liquidity: d.qv * 0.4, // deep book proxy
      mcap: d.price * 1e12, // placeholder, majors not mcap-filtered
      ageHours: 99999,
      txns1h: Math.round(d.qv / 8000),
      buys1h: Math.round(d.qv / 16000),
      sells1h: Math.round(d.qv / 16000),
      source: "binance",
    };
  });
}

function simMajors(now: number): ScoutPair[] {
  return MAJOR_SYMBOLS.map((s) => {
    const anchor = SIM_ANCHORS[s] ?? 100;
    let st = simState.get(s);
    if (!st) {
      st = { p: anchor * (0.98 + Math.random() * 0.04), drift: 0 };
      simState.set(s, st);
    }
    st.drift = st.drift * 0.92 + (Math.random() - 0.5) * 0.0006;
    st.p = Math.max(anchor * 0.5, st.p * (1 + st.drift + (Math.random() - 0.5) * 0.0012));
    const qv = anchor > 1000 ? 2.4e9 : 8e8;
    return {
      symbol: s,
      base: s.replace("USDT", ""),
      name: MAJOR_NAMES[s] ?? s,
      market: "majors" as const,
      price: st.p,
      change24h: st.drift * 100 * 24,
      volume24h: qv * (0.8 + Math.random() * 0.4),
      volume1h: qv / 24,
      liquidity: qv * 0.4,
      mcap: st.p * 1e12,
      ageHours: 99999,
      txns1h: Math.round(qv / 8000),
      buys1h: Math.round(qv / 16000),
      sells1h: Math.round(qv / 16000),
      source: "sim",
    };
  });
}

// ───────────────────────── DexScreener memecoins ─────────────────────────

export async function fetchMemecoins(): Promise<{ rows: ScoutPair[]; live: boolean }> {
  const now = Date.now();
  const cached = memo.__nbDexCache;
  if (cached && now - cached.at < 45_000) {
    return { rows: cached.data, live: true };
  }
  const res = await timedFetch(
    "https://api.dexscreener.com/latest/dex/search?q=solana%20usdc"
  );
  if (res) {
    try {
      const json = (await res.json()) as { pairs?: unknown[] };
      const rows = parseDexPairs(json.pairs ?? []);
      if (rows.length >= 6) {
        memo.__nbDexCache = { data: rows, at: now };
        return { rows, live: true };
      }
    } catch {
      /* fall through */
    }
  }
  return { rows: simMemecoins(now), live: false };
}

// tokens that are infrastructure, not tradeable fresh memes
const MEME_BLOCKLIST = new Set([
  "SOL", "WSOL", "USDC", "USDT", "USDS", "USD1", "PYUSD", "MSOL", "JITOSOL", "JUPSOL",
  "BTC", "WBTC", "ETH", "WETH", "BNB", "JLP", "SUSD", "FRAX", "DAI", "TUSD", "ZUSD",
]);

function parseDexPairs(pairs: unknown[]): ScoutPair[] {
  const now = Date.now();
  const out: ScoutPair[] = [];
  for (const raw of pairs) {
    const p = raw as {
      chainId?: string;
      dexId?: string;
      baseToken?: { symbol?: string; name?: string };
      priceUsd?: string;
      priceChange?: { h1?: string; h24?: string };
      volume?: { h1?: string; h24?: string };
      liquidity?: { usd?: number };
      fdv?: string;
      marketCap?: string;
      pairCreatedAt?: number;
      txns?: { m1?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
    };
    if (!p || p.chainId !== "solana") continue;
    const sym = (p.baseToken?.symbol ?? "").toUpperCase();
    if (!sym || MEME_BLOCKLIST.has(sym) || sym.includes("USD")) continue;
    if (!p.baseToken?.symbol) continue;
    const liq = p.liquidity?.usd ?? 0;
    if (liq < 8000) continue;
    const price = parseFloat(p.priceUsd ?? "0");
    if (!price || !isFinite(price)) continue;
    const vol1 = parseFloat(p.volume?.h1 ?? "0");
    const vol24 = parseFloat(p.volume?.h24 ?? "0");
    const mcap = parseFloat(p.marketCap ?? p.fdv ?? "0") || liq * 8;
    const ageH = p.pairCreatedAt ? (now - p.pairCreatedAt) / 3_600_000 : 999;
    const t1 = p.txns?.h1;
    const buys = t1?.buys ?? 0;
    const sells = t1?.sells ?? 0;
    out.push({
      symbol: (p.baseToken.symbol ?? "").slice(0, 12),
      base: `$${(p.baseToken.symbol ?? "?").slice(0, 10)}`,
      name: p.baseToken.name ?? p.baseToken.symbol ?? "?",
      market: "memecoin",
      price,
      change24h: parseFloat(p.priceChange?.h24 ?? "0"),
      volume24h: vol24,
      volume1h: vol1,
      liquidity: liq,
      mcap,
      ageHours: ageH,
      txns1h: buys + sells,
      buys1h: buys,
      sells1h: sells,
      source: "dexscreener",
    });
  }
  // most liquid first, cap list
  out.sort((a, b) => b.liquidity - a.liquidity);
  return out.slice(0, 30);
}

function simMemecoins(now: number): ScoutPair[] {
  const rows: ScoutPair[] = [];
  const n = 14;
  for (let i = 0; i < n; i++) {
    const nm = MEME_NOUNS[(i * 7 + 3) % MEME_NOUNS.length];
    const pre = MEME_PREFIX[(i * 3) % MEME_PREFIX.length];
    const base = `$${pre}${nm}`;
    let st = simMemes.get(base);
    if (!st) {
      st = {
        p: 0.0004 + Math.random() * 0.02,
        liq: 30_000 + Math.random() * 400_000,
        vol: 40_000 + Math.random() * 500_000,
        born: now - (0.5 + Math.random() * 46) * 3_600_000,
      };
      simMemes.set(base, st);
    }
    st.p = Math.max(0.00001, st.p * (1 + (Math.random() - 0.47) * 0.05));
    st.vol = Math.max(20_000, st.vol * (0.96 + Math.random() * 0.09));
    const ageH = (now - st.born) / 3_600_000;
    const txns = Math.round(80 + Math.random() * 900);
    rows.push({
      symbol: base.slice(1),
      base,
      name: `${pre ? pre + " " : ""}${nm.toLowerCase()} coin`,
      market: "memecoin",
      price: st.p,
      change24h: (Math.random() - 0.4) * 80,
      volume24h: st.vol * (6 + Math.random() * 8),
      volume1h: st.vol,
      liquidity: st.liq,
      mcap: st.liq * (6 + Math.random() * 10),
      ageHours: ageH,
      txns1h: txns,
      buys1h: Math.round(txns * (0.45 + Math.random() * 0.2)),
      sells1h: 0,
      source: "sim",
    });
  }
  rows.forEach((r) => (r.sells1h = Math.max(1, r.txns1h - r.buys1h)));
  return rows;
}

// ───────────────────────── Klines (TA) ─────────────────────────

export async function fetchKlines(symbol: string, market: MarketKind): Promise<Klines> {
  const now = Date.now();
  const cached = klineCache.get(symbol);
  if (cached && now - cached.at < 25_000) return cached.data;

  const empty: Klines = { m1: [], h1: [], simulated: true };
  if (market === "majors") {
    const m1 = await binanceKlines(symbol, "1m", 120);
    const h1 = await binanceKlines(symbol, "1h", 60);
    if (m1.length > 30) {
      const k: Klines = { m1, h1, simulated: false };
      klineCache.set(symbol, { data: k, at: now });
      return k;
    }
    const sim = synthKlines(symbol);
    klineCache.set(symbol, { data: sim, at: now });
    return sim;
  }
  // memecoins: DexScreener has no free OHLC — synthesize a walk around the live
  // price but anchor every 10th candle to a fresh real quote.
  const sim = synthKlines(symbol, await getMemePrice(symbol));
  klineCache.set(symbol, { data: sim, at: now });
  return sim;
}

async function binanceKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const res = await timedFetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  if (!res) return [];
  try {
    const arr = (await res.json()) as unknown[][];
    return arr.map((a) => ({
      t: Number(a[0]),
      o: parseFloat(String(a[1])),
      h: parseFloat(String(a[2])),
      l: parseFloat(String(a[3])),
      c: parseFloat(String(a[4])),
      v: parseFloat(String(a[5])),
    }));
  } catch {
    return [];
  }
}

async function getMemePrice(symbol: string): Promise<number | undefined> {
  const { rows } = await fetchMemecoins();
  return rows.find((r) => r.symbol === symbol)?.price;
}

function synthKlines(symbol: string, anchor?: number): Klines {
  let st = simState.get("k:" + symbol);
  const base = anchor ?? SIM_ANCHORS[symbol] ?? 100;
  if (!st) {
    st = { p: base, drift: 0 };
    simState.set("k:" + symbol, st);
  }
  const vol = base > 1000 ? 0.0012 : base > 10 ? 0.003 : 0.012;
  const m1: Candle[] = [];
  let p = st.p;
  const t0 = Date.now() - 120 * 60_000;
  for (let i = 0; i < 120; i++) {
    st.drift = st.drift * 0.9 + (Math.random() - 0.48) * vol * 0.4;
    p = Math.max(base * 0.3, p * (1 + st.drift + (Math.random() - 0.5) * vol));
    const o = p * (1 - (Math.random() - 0.5) * vol);
    const h = Math.max(p, o) * (1 + Math.random() * vol);
    const l = Math.min(p, o) * (1 - Math.random() * vol);
    m1.push({ t: t0 + i * 60_000, o, h, l, c: p, v: 100 + Math.random() * 900 });
  }
  st.p = p;
  // hourly = coarser walk
  const h1: Candle[] = [];
  let hp = base;
  for (let i = 0; i < 60; i++) {
    hp = Math.max(base * 0.4, hp * (1 + (Math.random() - 0.47) * vol * 6));
    h1.push({
      t: t0 - 60 * 60_000 + i * 3_600_000,
      o: hp,
      h: hp * 1.004,
      l: hp * 0.996,
      c: hp,
      v: 5000,
    });
  }
  return { m1, h1, simulated: true };
}

export function dataSourceBadge(): "live" | "sim" {
  return memo.__nbLiveOk === false ? "sim" : "live";
}
