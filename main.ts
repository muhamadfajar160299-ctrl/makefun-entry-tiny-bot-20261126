// Tiny trend bot: multi-symbol trend-following with confirmation,
// volatility-sized entries and tight trailing stops.
//
// Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin/stdout.
// The harness sends one hello, then one batch per bar, then done.
// The bot answers exactly one reply per batch, echoing its seq.
// Prices, quantities and quote amounts are integer decimal strings at the
// scales announced in hello; times are milliseconds.
//
// Idea (written from scratch): only buy an asset when several independent
// trend readings agree at the same time, size the trade so that a normal
// volatile move risks about the same dollars on every symbol, and get out
// quickly when the trend breaks or the price falls a fixed multiple of
// recent volatility below its peak. No shorts, no leverage, never all-in:
// at most one fifth of equity in any single symbol, and cash is always kept
// in reserve for the other symbols. Weak signals are ignored entirely.

import * as readline from "node:readline";

type Bar = { o: number; h: number; l: number; c: number };

type SymState = {
  closes: number[];
  highs: number[];
  lows: number[];
  entryPrice: number | null;
  entryAtr: number | null;
  peak: number | null;
};

const FAST = 12; // fast smoothing length
const SLOW = 48; // slow smoothing length
const ATR_LEN = 14;
const MIN_BARS = 60; // history needed before any signal is trusted
const MAX_SYM_WEIGHT = 0.2; // never more than 20% of equity in one symbol
const RISK_PER_TRADE = 0.01; // 1% of equity risked per new position
const STOP_ATR = 2.5; // stop distance in multiples of ATR
const TRAIL_ATR = 3.0; // trailing give-back in multiples of ATR
const TREND_MIN = 0.5; // (fast - slow) / ATR needed to enter
const SLOPE_MIN = 0.1; // slow-line slope per bar, in ATR units

let priceScale = new Map<string, number>();
let qtyScale = new Map<string, number>();
let quoteScale = 6;
let capitalUnits = 0n;
let maxOpenPositions = 6;
let maxOrdersPerBar = 6;
let maxWeightBps = 2000;
let minNotionalUnits = 0n;
let slipBps = 200;
let warmupBars = 0;

const state = new Map<string, SymState>();
const pendingBuy = new Set<string>();

function st(sym: string): SymState {
  let s = state.get(sym);
  if (!s) {
    s = { closes: [], highs: [], lows: [], entryPrice: null, entryAtr: null, peak: null };
    state.set(sym, s);
  }
  return s;
}

function toFloat(raw: string, scale: number): number {
  return Number(raw) / 10 ** scale;
}

function ema(values: number[], len: number): number {
  const k = 2 / (len + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let e = values[0];
  out.push(e);
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

function atr(s: SymState): number {
  const n = Math.min(ATR_LEN, s.closes.length - 1);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = s.closes.length - n; i < s.closes.length; i++) {
    const prev = s.closes[i - 1];
    const tr = Math.max(s.highs[i] - s.lows[i], Math.abs(s.highs[i] - prev), Math.abs(s.lows[i] - prev));
    sum += tr;
  }
  return sum / n;
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let orderSeq = 0;

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      for (const s of msg.symbols ?? []) {
        priceScale.set(s.symbol, s.price_scale);
        qtyScale.set(s.symbol, s.qty_scale);
      }
      quoteScale = msg.capital?.quote_scale ?? 6;
      capitalUnits = BigInt(msg.capital?.quote_units ?? "0");
      maxOpenPositions = msg.caps?.max_open_positions ?? 6;
      maxOrdersPerBar = msg.caps?.max_orders_per_bar ?? 6;
      maxWeightBps = msg.caps?.max_weight_bps ?? 2000;
      minNotionalUnits = BigInt(msg.fees?.min_notional_quote_units ?? "0");
      slipBps = msg.fees?.slippage_bps ? Math.min(500, msg.fees.slippage_bps) : 200;
      warmupBars = msg.warmup_bars ?? 0;
      return;
    }

    if (msg.type === "done") {
      process.exit(0);
    }

    if (msg.type !== "batch") return;

    const seq: number = msg.seq;
    const bars: any[] = msg.bars ?? [];
    const fills: any[] = msg.fills ?? [];
    const account: any = msg.account ?? {};
    const cashUnits = BigInt(account.cash_quote_units ?? "0");
    const equityUnits = BigInt(account.equity_quote_units ?? "0");
    const equity = Number(equityUnits) / 10 ** quoteScale;
    const cash = Number(cashUnits) / 10 ** quoteScale;

    // Record fills first: a filled buy sets the entry, a filled sell clears it.
    for (const f of fills) {
      if (f.status !== "filled") {
        if (f.side === "buy") pendingBuy.delete(f.symbol);
        continue;
      }
      const s = st(f.symbol);
      const px = toFloat(f.price, priceScale.get(f.symbol) ?? 0);
      if (f.side === "buy") {
        pendingBuy.delete(f.symbol);
        s.entryPrice = px;
        s.entryAtr = atr(s);
        s.peak = px;
      } else {
        s.entryPrice = null;
        s.entryAtr = null;
        s.peak = null;
      }
    }

    // Append this batch's bars.
    for (const b of bars) {
      const s = st(b.symbol);
      const ps = priceScale.get(b.symbol) ?? 0;
      s.closes.push(toFloat(b.c, ps));
      s.highs.push(toFloat(b.h, ps));
      s.lows.push(toFloat(b.l, ps));
      if (s.closes.length > 400) {
        s.closes.shift();
        s.highs.shift();
        s.lows.shift();
      }
    }

    // Authoritative positions from the account snapshot.
    const held = new Map<string, string>(); // symbol -> qty string
    for (const p of account.positions ?? []) {
      held.set(p.symbol, p.qty);
      const s = st(p.symbol);
      if (s.entryPrice === null && s.closes.length > 0) {
        const qty = Number(p.qty) / 10 ** (qtyScale.get(p.symbol) ?? 0);
        const cost = Number(p.cost_quote_units) / 10 ** quoteScale;
        if (qty > 0) {
          s.entryPrice = cost / qty;
          s.entryAtr = atr(s);
          s.peak = s.closes[s.closes.length - 1];
        }
      }
      if (s.peak !== null && s.closes.length > 0) {
        s.peak = Math.max(s.peak, s.closes[s.closes.length - 1]);
      }
    }

    const orders: any[] = [];
    const ready = seq >= warmupBars && bars.length > 0;

    // ---- Exits first: protect capital before opening anything new. ----
    if (ready) {
      for (const [sym, qtyStr] of held) {
        const s = state.get(sym);
        if (!s || s.closes.length < MIN_BARS) continue;
        const close = s.closes[s.closes.length - 1];
        const a = atr(s);
        if (a <= 0) continue;
        const fast = ema(s.closes, FAST);
        const slow = ema(s.closes, SLOW);
        let exit = false;
        if (s.entryPrice !== null && s.entryAtr !== null && s.entryAtr > 0) {
          if (close <= s.entryPrice - STOP_ATR * s.entryAtr) exit = true; // hard stop
        }
        if (s.peak !== null && close <= s.peak - TRAIL_ATR * a) exit = true; // trailing stop
        if (fast < slow) exit = true; // trend broken
        if (exit && orders.length < maxOrdersPerBar) {
          orderSeq += 1;
          orders.push({
            side: "sell",
            client_id: `s-${seq}-${sym}-${orderSeq}`,
            symbol: sym,
            qty: qtyStr,
            max_slippage_bps: slipBps,
          });
        }
      }
    }

    // ---- Entries: only when every confirmation agrees. ----
    if (ready) {
      const openSlots = Math.max(0, maxOpenPositions - held.size);
      if (openSlots > 0 && orders.length < maxOrdersPerBar) {
        type Cand = { sym: string; score: number; price: number; a: number };
        const cands: Cand[] = [];
        for (const b of bars) {
          const sym: string = b.symbol;
          if (held.has(sym) || pendingBuy.has(sym)) continue;
          const s = state.get(sym);
          if (!s || s.closes.length < MIN_BARS) continue;
          const close = s.closes[s.closes.length - 1];
          const open = toFloat(b.o, priceScale.get(sym) ?? 0);
          const a = atr(s);
          if (a <= 0 || a / close > 0.08) continue; // skip absurd volatility
          if (close / open > 1.12) continue; // skip one-bar vertical spike
          const fast = ema(s.closes, FAST);
          const slowArr = emaSeries(s.closes, SLOW);
          const slow = slowArr[slowArr.length - 1];
          const slowAgo = slowArr[Math.max(0, slowArr.length - 25)];
          const slope = (slow - slowAgo) / 24 / a;
          const spread = (fast - slow) / a;
          if (!(fast > slow)) continue;
          if (!(close > fast)) continue;
          if (spread < TREND_MIN) continue;
          if (slope < SLOPE_MIN) continue;
          cands.push({ sym, score: spread + slope, price: close, a });
        }
        cands.sort((x, y) => y.score - x.score);
        const capWeight = Math.min(maxWeightBps / 10000, MAX_SYM_WEIGHT);
        for (const c of cands) {
          if (orders.length >= maxOrdersPerBar) break;
          if (cands.indexOf(c) >= openSlots) break;
          // Volatility-sized notional: risk ~1% of equity if price falls
          // one stop-distance (2.5 ATR) against us, capped per symbol.
          const riskDollars = RISK_PER_TRADE * equity;
          const stopDist = STOP_ATR * c.a;
          let notional = stopDist > 0 ? riskDollars / stopDist * c.price : 0;
          notional = Math.min(notional, capWeight * equity, cash * 0.5);
          if (notional <= 0) continue;
          const units = BigInt(Math.floor(notional * 10 ** quoteScale));
          if (units < minNotionalUnits) continue;
          if (units > cashUnits / 2n && cashUnits > 0n) continue;
          orderSeq += 1;
          pendingBuy.add(c.sym);
          orders.push({
            side: "buy",
            client_id: `b-${seq}-${c.sym}-${orderSeq}`,
            symbol: c.sym,
            notional_quote_units: units.toString(),
            max_slippage_bps: slipBps,
          });
        }
      }
    }

    process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
  });
}

main();
