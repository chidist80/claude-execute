// Walk-forward-safe indicator series. Pure functions; no I/O.
// Shared between bot.js (single-point) and backtest strategies (full series).

export function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const mult = 2 / (period + 1);
  let cur = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = cur;
  for (let i = period; i < closes.length; i++) {
    cur = closes[i] * mult + cur * (1 - mult);
    out[i] = cur;
  }
  return out;
}

export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  for (let i = period; i < closes.length; i++) {
    let gains = 0,
      losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Session VWAP, resets at each midnight UTC
export function vwapSeries(candles) {
  const out = new Array(candles.length).fill(null);
  let dayKey = null;
  let cumTPV = 0,
    cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const utc = new Date(c.time);
    const key = `${utc.getUTCFullYear()}-${utc.getUTCMonth()}-${utc.getUTCDate()}`;
    if (key !== dayKey) {
      dayKey = key;
      cumTPV = 0;
      cumVol = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    out[i] = cumVol > 0 ? cumTPV / cumVol : null;
  }
  return out;
}

// Highest high / lowest low over a trailing window — used by Donchian-style strategies.
export function rollingHigh(candles, window) {
  const out = new Array(candles.length).fill(null);
  for (let i = window - 1; i < candles.length; i++) {
    let h = -Infinity;
    for (let j = i - window + 1; j <= i; j++) if (candles[j].high > h) h = candles[j].high;
    out[i] = h;
  }
  return out;
}

export function rollingLow(candles, window) {
  const out = new Array(candles.length).fill(null);
  for (let i = window - 1; i < candles.length; i++) {
    let l = Infinity;
    for (let j = i - window + 1; j <= i; j++) if (candles[j].low < l) l = candles[j].low;
    out[i] = l;
  }
  return out;
}

// Simple moving average over `period` candles' close.
export function smaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = closes.slice(0, period).reduce((a, b) => a + b, 0);
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    out[i] = sum / period;
  }
  return out;
}
