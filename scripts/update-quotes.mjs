// Busca cotações, proventos, indicadores, dólar e Selic/CDI/IPCA na brapi e grava quotes.json (lido pelo site).
// Uso: BRAPI_TOKEN=... node scripts/update-quotes.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { brapi, BrapiError, arr, num } from './brapi.mjs';

const OUT = process.env.QUOTES_OUT || 'quotes.json';
const cfg = JSON.parse(await readFile(process.env.TICKERS_FILE || 'tickers.json', 'utf8'));
const clean = l => [...new Set(arr(l).map(s => String(s).trim().toUpperCase()).filter(Boolean))];
const fiis = clean(cfg.fiis), outros = clean(cfg.acoes).filter(s => !fiis.includes(s));
const all = [...fiis, ...outros];

let prev = {}; try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
const out = { updatedAt: new Date().toISOString(), quotes: {}, dividends: {}, indicators: {}, fx: {}, macro: {}, errors: [] };
const fail = (what, e) => { out.errors.push({ what, status: e.status ?? null, message: e.message }); console.warn(`✗ ${what}: ${e.message}`); };
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const keep = k => { out[k] = prev[k] || {}; };   // se uma seção falhar, mantém a anterior

/** Tenta em lotes (symbols=A,B,C). Se o plano recusar o lote, refaz um ativo por vez. 401 interrompe tudo. */
async function perSymbol(path, symbols, extra, pick, size = 20) {
  const got = {};
  const one = async batch => { const j = await brapi(path, { symbols: batch.join(','), ...extra }); Object.assign(got, pick(j, batch)); };
  for (const batch of chunks(symbols, size)) {
    try { await one(batch); }
    catch (e) {
      if (e.status === 401 || e.status === 403 && batch.length === 1) throw e;
      if (batch.length > 1 && [400, 402, 403, 404, 429].includes(e.status)) {
        for (const s of batch) { try { await one([s]); } catch (e2) { if (e2.status === 401) throw e2; fail(`${path} ${s}`, e2); } }
      } else throw e;
    }
  }
  return got;
}

try {
  // 1) Cotação — /api/v2/stocks/quote  (results[].symbol, results[].data.regularMarketPrice …)
  if (all.length) {
    try {
      out.quotes = await perSymbol('stocks/quote', all, {}, j => {
        const r = {};
        for (const it of arr(j.results)) {
          const d = it && it.data, sym = String((it && (it.symbol || it.requestedSymbol)) || '').toUpperCase(), price = d && num(d.regularMarketPrice);
          if (sym && price > 0) r[sym] = { price, change: num(d.regularMarketChangePercent), time: d.regularMarketTime ?? null };
        }
        return r;
      });
      for (const s of all) if (!out.quotes[s]) fail(`cotação ${s}`, new BrapiError(404, 'sem preço na resposta'));
    } catch (e) { if (e.status === 401) throw e; fail('cotações', e); keep('quotes'); }
  }

  // 2) Proventos — FIIs: /api/v2/fii/dividends · ações/ETFs: /api/v2/stocks/dividends
  const divs = {}; let divOk = false;
  if (fiis.length) {
    try {
      Object.assign(divs, await perSymbol('fii/dividends', fiis, {}, j => {
        const r = {};
        for (const d of arr(j.dividends)) {
          const s = String(d.symbol || '').toUpperCase(), rate = num(d.rate); if (!s || !(rate > 0)) continue;
          (r[s] ||= []).push({ rate, paymentDate: String(d.paymentDate || '').slice(0, 10), label: d.label || null });
        }
        return r;
      })); divOk = true;
    } catch (e) { if (e.status === 401) throw e; fail('proventos de FIIs', e); }
  }
  if (outros.length) {
    try {
      Object.assign(divs, await perSymbol('stocks/dividends', outros, {}, j => {
        const r = {};
        for (const it of arr(j.results)) {
          const s = String((it && (it.symbol || it.requestedSymbol)) || '').toUpperCase(), list = arr(it && it.data && it.data.cashDividends); if (!s) continue;
          for (const d of list) {
            const rate = num(d.rate ?? d.value ?? d.rawRate); if (!(rate > 0)) continue;
            (r[s] ||= []).push({ rate, paymentDate: String(d.paymentDate || d.date || '').slice(0, 10), label: d.label || d.type || null });
          }
        }
        return r;
      })); divOk = true;
    } catch (e) { if (e.status === 401) throw e; fail('proventos de ações', e); }
  }
  for (const l of Object.values(divs)) l.sort((a, b) => (b.paymentDate || '').localeCompare(a.paymentDate || ''));
  out.dividends = divOk ? divs : (keep('dividends'), out.dividends);

  // 3) Indicadores — FIIs: /api/v2/fii/indicators · ações: /api/v2/stocks/statistics
  if (fiis.length) {
    try {
      Object.assign(out.indicators, await perSymbol('fii/indicators', fiis, {}, j => {
        const r = {};
        for (const f of arr(j.fiis)) { const s = String(f.symbol || '').toUpperCase(); if (s) r[s] = { priceToNav: num(f.priceToNav), dividendYield12m: num(f.dividendYield12m), dividendYield1m: num(f.dividendYield1m), navPerShare: num(f.navPerShare), equity: num(f.equity), asOf: f.asOfDate ?? null }; }
        return r;
      }));
    } catch (e) { if (e.status === 401) throw e; fail('indicadores de FIIs', e); Object.assign(out.indicators, Object.fromEntries(fiis.filter(s => prev.indicators && prev.indicators[s]).map(s => [s, prev.indicators[s]]))); }
  }
  if (outros.length) {
    try {
      Object.assign(out.indicators, await perSymbol('stocks/statistics', outros, { mode: 'current' }, j => {
        const r = {};
        for (const it of arr(j.results)) { const s = String((it && (it.symbol || it.requestedSymbol)) || '').toUpperCase(), d = it && it.data; if (s && d) r[s] = { priceToBook: num(d.priceToBook), dividendYield: num(d.dividendYield), trailingEps: num(d.trailingEps), trailingPE: num(d.trailingPE ?? d.priceToEarnings), beta: num(d.beta) }; }
        return r;
      }));
    } catch (e) { if (e.status === 401) throw e; fail('indicadores de ações', e); Object.assign(out.indicators, Object.fromEntries(outros.filter(s => prev.indicators && prev.indicators[s]).map(s => [s, prev.indicators[s]]))); }
  }

  // 4) Dólar — /api/v2/currency?currency=USD-BRL
  try {
    const j = await brapi('currency', { currency: 'USD-BRL' });
    const c = arr(j.currency)[0], bid = c && num(c.bidPrice);
    if (bid > 0) out.fx.USDBRL = { bid, ask: num(c.askPrice), at: c.updatedAtDate ?? null };
    else fail('dólar', new BrapiError(404, 'sem cotação na resposta'));
  } catch (e) { if (e.status === 401) throw e; fail('dólar', e); keep('fx'); }

  // 5) Macro — /api/v2/macro/latest?symbols=selic,cdi,ipca  (results[].series, results[].latest.{date,value})
  try {
    const j = await brapi('macro/latest', { symbols: 'selic,cdi,ipca' });
    for (const it of arr(j.results)) { const k = String(it.series || it.symbol || '').toLowerCase(), v = it.latest && num(it.latest.value); if (k && v != null) out.macro[k] = { value: v, date: it.latest.date ?? null }; }
    if (!Object.keys(out.macro).length) fail('macro', new BrapiError(404, 'sem séries na resposta'));
  } catch (e) { if (e.status === 401) throw e; fail('macro', e); keep('macro'); }
} catch (e) {
  console.error(`Abortado: ${e.message}`);
  if (e.status === 401) { await writeFile(OUT, JSON.stringify({ ...prev, errors: [{ what: 'autenticação', status: 401, message: e.message }] }, null, 2) + '\n'); process.exit(1); }
  throw e;
}

await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`quotes.json: ${Object.keys(out.quotes).length} cotações, ${Object.keys(out.dividends).length} com proventos, ${out.errors.length} aviso(s).`);
if (all.length && !Object.keys(out.quotes).length) process.exit(1);
