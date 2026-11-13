// Cliente mínimo da brapi.dev (/api/v2). A chave vem SÓ da variável de ambiente BRAPI_TOKEN.
const BASE = process.env.BRAPI_BASE || 'https://brapi.dev';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class BrapiError extends Error {
  constructor(status, message, endpoint) { super(message); this.status = status; this.endpoint = endpoint; }
}

const MSG = {
  401: 'chave ausente ou inválida (confira o Secret BRAPI_TOKEN)',
  403: 'o seu plano da brapi não inclui este dado',
  404: 'ativo não encontrado',
  429: 'limite de consultas atingido',
};

/** GET em /api/v2/<path>. Respeita Retry-After no 429 (até 2 novas tentativas, espera máxima de 60 s). */
export async function brapi(path, params = {}, { retries = 2 } = {}) {
  const token = process.env.BRAPI_TOKEN;
  if (!token) throw new BrapiError(401, 'variável BRAPI_TOKEN não definida', path);
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const url = `${BASE}/api/v2/${path}${qs ? '?' + qs : ''}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); }
    catch (e) { throw new BrapiError(0, 'sem conexão com a brapi', path); }
    if (res.status === 429 && attempt < retries) {
      const wait = Math.min(60, Math.max(1, Number(res.headers.get('retry-after')) || 5));
      console.warn(`429 em ${path}; aguardando ${wait}s`);
      await sleep(wait * 1000); continue;
    }
    if (!res.ok) throw new BrapiError(res.status, MSG[res.status] || `erro HTTP ${res.status}`, path);
    try { return await res.json(); } catch { throw new BrapiError(res.status, 'resposta não é JSON', path); }
  }
}

export const arr = v => Array.isArray(v) ? v : [];
/** Converte para número ou null (a brapi pode mandar null, texto ou vazio). */
export const num = v => { const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
