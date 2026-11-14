// ─── Real-money order layer: every order is written to the DB BEFORE it is sent ───
// If the app dies mid-request, boot reconciliation finds the order on Coinbase by its client id
// and records what actually happened. Also manages the resting bracket that protects each position.

import crypto from "node:crypto";
import { db } from "@/lib/db";
import {
  CbError,
  cbBracketSell,
  cbCancel,
  cbFindByClientId,
  cbMarketOrder,
  cbOrderStatus,
  cbProducts,
  toProductId,
  type CbFill,
  type CbOrderState,
} from "./coinbase";

type Purpose = "entry" | "tp1" | "exit" | "protect";

const mapStatus = (s: string): string =>
  s === "FILLED" ? "FILLED"
  : s === "CANCELLED" || s === "EXPIRED" ? "CANCELLED"
  : s === "FAILED" ? "REJECTED"
  : s === "OPEN" || s === "PENDING" || s === "QUEUED" || s === "CANCEL_QUEUED" ? "OPEN"
  : "UNKNOWN";

async function record(data: Parameters<typeof db.order.create>[0]["data"]): Promise<string | null> {
  try {
    return (await db.order.create({ data })).id;
  } catch {
    return null; // never block a real-money action on an audit write
  }
}
async function patch(id: string | null, data: Parameters<typeof db.order.update>[0]["data"]) {
  if (!id) return;
  try {
    await db.order.update({ where: { id }, data });
  } catch { /* audit only */ }
}

/** market order with an audit row written before the request leaves */
export async function liveMarket(a: {
  symbol: string;
  side: "BUY" | "SELL";
  purpose: Purpose;
  quoteUsd?: number;
  baseQty?: number;
  tradeId?: string;
}): Promise<CbFill> {
  const [prod] = await cbProducts([toProductId(a.symbol)], 1500);
  if (!prod) throw new CbError(`${toProductId(a.symbol)} not found`);
  if (!prod.tradable) throw new CbError(`${prod.id} not tradable`);
  const clientId = crypto.randomUUID();
  const rowId = await record({
    clientOrderId: clientId, productId: prod.id, side: a.side, kind: "market", purpose: a.purpose,
    status: "INTENT", tradeId: a.tradeId ?? "", quoteSize: a.quoteUsd ?? 0, baseSize: a.baseQty ?? 0,
  });
  try {
    const size = a.quoteUsd !== undefined
      ? { quoteUsd: a.quoteUsd, quoteInc: prod.quoteIncrement }
      : { baseQty: a.baseQty ?? 0, baseInc: prod.baseIncrement };
    const fill = await cbMarketOrder(prod.id, a.side, size, clientId); // recovers a lost reply by client id itself
    await patch(rowId, { status: "FILLED", exchangeId: fill.orderId, filledSize: fill.filledSize, filledValue: fill.grossUsd, fees: fill.feesUsd });
    return fill;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const rejected = e instanceof CbError && (e.status >= 400 && e.status < 500 || /rejected|no fill/.test(msg));
    await patch(rowId, { status: rejected ? "REJECTED" : "UNKNOWN", error: msg.slice(0, 300) });
    throw e;
  }
}

/** place the resting bracket (take-profit limit + stop trigger) that protects a live position on Coinbase */
export async function placeProtection(a: { symbol: string; baseQty: number; takeProfit: number; stop: number; tradeId: string }): Promise<string> {
  const [prod] = await cbProducts([toProductId(a.symbol)], 1500);
  if (!prod) throw new CbError(`${toProductId(a.symbol)} not found`);
  const clientId = crypto.randomUUID();
  const rowId = await record({
    clientOrderId: clientId, productId: prod.id, side: "SELL", kind: "bracket", purpose: "protect",
    status: "INTENT", tradeId: a.tradeId, baseSize: a.baseQty, stopPrice: a.stop, limitPrice: a.takeProfit,
  });
  try {
    const id = await cbBracketSell(prod.id, a.baseQty, { baseInc: prod.baseIncrement, quoteInc: prod.quoteIncrement }, a.takeProfit, a.stop, clientId);
    await patch(rowId, { status: "OPEN", exchangeId: id });
    return id;
  } catch (e) {
    await patch(rowId, { status: "REJECTED", error: (e instanceof Error ? e.message : "error").slice(0, 300) });
    throw e;
  }
}

async function syncRow(exchangeId: string, st: CbOrderState) {
  try {
    await db.order.updateMany({
      where: { exchangeId },
      data: { status: mapStatus(st.status), filledSize: st.fill.filledSize, filledValue: st.fill.grossUsd, fees: st.fill.feesUsd },
    });
  } catch { /* audit only */ }
}

/** current state of a resting order (and keep the audit row in step) */
export async function orderState(exchangeId: string): Promise<CbOrderState | null> {
  const st = await cbOrderStatus(exchangeId);
  if (st) await syncRow(exchangeId, st);
  return st;
}

/** cancel a resting bracket, then report what really happened to it (it may have filled first) */
export async function cancelProtection(exchangeId: string): Promise<{ state: CbOrderState | null; filled: boolean }> {
  try {
    await cbCancel([exchangeId]);
  } catch { /* fall through: the status read below tells the truth */ }
  let st: CbOrderState | null = null;
  for (let i = 0; i < 6; i++) {
    st = await cbOrderStatus(exchangeId).catch(() => null);
    if (st && st.status !== "OPEN" && st.status !== "CANCEL_QUEUED" && st.status !== "PENDING") break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (st) await syncRow(exchangeId, st);
  return { state: st, filled: !!st && st.fill.filledSize > 0 };
}

/** boot: resolve every order that was in flight when the app stopped */
export async function reconcileOrders(log: (lvl: string, msg: string) => void): Promise<{ resolved: number; unresolved: number }> {
  let resolved = 0;
  let unresolved = 0;
  const rows = await db.order.findMany({ where: { status: { in: ["INTENT", "UNKNOWN", "OPEN"] } } }).catch(() => []);
  for (const r of rows) {
    try {
      const found = r.exchangeId
        ? await cbOrderStatus(r.exchangeId).then((st) => (st ? { orderId: r.exchangeId, ...st } : null))
        : await cbFindByClientId(r.clientOrderId, r.productId);
      if (found) {
        await db.order.update({
          where: { id: r.id },
          data: { exchangeId: found.orderId, status: mapStatus(found.status), filledSize: found.fill.filledSize, filledValue: found.fill.grossUsd, fees: found.fill.feesUsd },
        });
        if (r.status !== "OPEN" || mapStatus(found.status) !== "OPEN") {
          resolved++;
          if (r.kind === "market" && found.fill.filledSize > 0 && r.status !== "FILLED") {
            log("RISK", `reconcile: an in-flight ${r.side} ${r.productId} DID fill (${found.fill.filledSize}) while the app was down — check the positions/balances`);
          }
        }
      } else if (r.status === "INTENT") {
        await db.order.update({ where: { id: r.id }, data: { status: "REJECTED", error: "never reached Coinbase" } });
        resolved++;
      } else unresolved++;
    } catch {
      unresolved++;
    }
  }
  if (resolved || unresolved) log("BOOT", `order reconciliation: ${resolved} resolved · ${unresolved} unresolved`);
  return { resolved, unresolved };
}
