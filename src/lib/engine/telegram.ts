// ─── Telegram alerts: push target / breaker / trade / brain events to a chat ───
// Fire-and-forget with a serialized send queue so a burst of closes never
// floods the Bot API (30 msg/s limit — we stay far below it). Fully optional:
// nothing happens until a bot token + chat id are saved in settings.

export type TgEventKind = "target" | "breaker" | "trades" | "brain";

export interface TgEventsConfig {
  target: boolean; // daily / weekly profit target booked
  breaker: boolean; // daily / weekly loss-cap circuit breaker
  trades: boolean; // every position close with P&L
  brain: boolean; // autotune cycles + major brain lessons
}

export const TG_DEFAULT_EVENTS: TgEventsConfig = {
  target: true,
  breaker: true,
  trades: true,
  brain: true,
};

interface TgState {
  token: string;
  chatId: string;
  enabled: boolean;
  events: TgEventsConfig;
  queue: string[];
  pumping: boolean;
  sentCount: number;
  lastError: string;
}

const g = globalThis as unknown as { __nbTelegram?: TgState };

function state(): TgState {
  return (g.__nbTelegram ??= {
    token: "",
    chatId: "",
    enabled: false,
    events: { ...TG_DEFAULT_EVENTS },
    queue: [],
    pumping: false,
    sentCount: 0,
    lastError: "",
  });
}

export function tgConfigure(cfg: { token?: string; chatId?: string; enabled?: boolean; events?: Partial<TgEventsConfig> }) {
  const s = state();
  if (typeof cfg.token === "string") s.token = cfg.token.trim();
  if (typeof cfg.chatId === "string") s.chatId = cfg.chatId.trim();
  if (typeof cfg.enabled === "boolean") s.enabled = cfg.enabled;
  if (cfg.events) s.events = { ...s.events, ...cfg.events };
}

export function tgConfig(): { enabled: boolean; configured: boolean; masked: string; events: TgEventsConfig; sentCount: number; lastError: string } {
  const s = state();
  const configured = s.token.length > 8 && s.chatId.length > 2;
  const masked = s.token ? `${s.token.slice(0, 6)}…${s.token.slice(-3)}` : "";
  return { enabled: s.enabled && configured, configured, masked, events: s.events, sentCount: s.sentCount, lastError: s.lastError };
}

export function tgEnabledFor(kind: TgEventKind): boolean {
  const s = state();
  return s.enabled && s.events[kind];
}

/** escape for Telegram HTML parse mode */
function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** queue a message — event text is plain log style, wrapped with an HTML header */
export function tgNotify(kind: TgEventKind, header: string, body: string): void {
  const s = state();
  if (!tgEnabledFor(kind)) return;
  const msg = `<b>${esc(header)}</b>\n${esc(body).slice(0, 700)}`;
  if (s.queue.length > 12) s.queue.shift(); // drop oldest under flood
  s.queue.push(msg);
  void pump();
}

/** one-off test from the settings dialog */
export async function tgSendTest(token: string, chatId: string): Promise<{ ok: boolean; error: string }> {
  if (!token || !chatId) return { ok: false, error: "bot token and chat id required" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId.trim(),
        text: "<b>Neuro Bot Terminal</b>\ntest alert — connection OK ✓\ntarget / breaker / trade / brain events will land here",
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${txt.slice(0, 120)}` };
    }
    const j = (await res.json()) as { ok?: boolean; description?: string };
    return j.ok ? { ok: true, error: "" } : { ok: false, error: j.description ?? "telegram rejected" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

async function pump(): Promise<void> {
  const s = state();
  if (s.pumping) return;
  s.pumping = true;
  try {
    while (s.queue.length > 0) {
      const msg = s.queue.shift()!;
      if (!s.token || !s.chatId) continue;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(`https://api.telegram.org/bot${s.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: s.chatId, text: msg, parse_mode: "HTML", disable_web_page_preview: true }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (res.ok) {
          s.sentCount += 1;
          s.lastError = "";
        } else {
          s.lastError = `HTTP ${res.status}`;
          if (res.status === 429) await new Promise((r) => setTimeout(r, 1500)); // back off on flood
        }
      } catch (e) {
        s.lastError = e instanceof Error ? e.message : "send failed";
      }
      await new Promise((r) => setTimeout(r, 900)); // ≥1 msg / 900ms — far under limits
    }
  } finally {
    s.pumping = false;
  }
}
