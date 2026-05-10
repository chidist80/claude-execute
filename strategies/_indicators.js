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

// Average True Range. Wilder's smoothing.
export function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trs[i] = tr;
  }
  let atr = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

// N-period return (close[i] / close[i-N] - 1). Returns 0 if not enough data.
export function returnSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    if (closes[i - period] > 0) {
      out[i] = closes[i] / closes[i - period] - 1;
    }
  }
  return out;
}

// Rolling z-score: (value - rolling_mean) / rolling_std over `window` previous samples.
// Walk-forward safe: at index i, uses samples [i-window+1 ... i].
export function zScoreSeries(values, window) {
  const out = new Array(values.length).fill(null);
  if (window < 2 || values.length < window) return out;
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0,
      n = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] != null) {
        sum += values[j];
        n++;
      }
    }
    if (n < 2) continue;
    const mean = sum / n;
    let sq = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] != null) sq += (values[j] - mean) ** 2;
    }
    const std = Math.sqrt(sq / (n - 1));
    if (std > 1e-12 && values[i] != null) out[i] = (values[i] - mean) / std;
  }
  return out;
}

// Realised vol over `window` candles, as σ of log returns. Annualized factor optional.
export function realizedVolSeries(closes, window, annualizeFactor = 1) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < window + 1) return out;
  const logRets = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      logRets[i] = Math.log(closes[i] / closes[i - 1]);
    }
  }
  for (let i = window; i < closes.length; i++) {
    let sum = 0,
      n = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (logRets[j] != null) {
        sum += logRets[j];
        n++;
      }
    }
    if (n < 2) continue;
    const mean = sum / n;
    let sq = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (logRets[j] != null) sq += (logRets[j] - mean) ** 2;
    }
    const std = Math.sqrt(sq / (n - 1));
    out[i] = std * Math.sqrt(annualizeFactor);
  }
  return out;
}
