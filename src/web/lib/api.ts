/**
 * API 呼び出し。エラーは必ず {status, code, error, ...} に正規化し、サーバーの理由をそのまま画面に出せるようにする。
 * タイムアウト 20秒。通信中の二重送信は呼び出し側（ボタン無効化）で防ぐ。
 */
export interface ApiError { status: number; code: string; error: string; field?: string; [k: string]: unknown }
export class ApiFailure extends Error {
  constructor(public info: ApiError) { super(info.error); }
}
export const isApiFailure = (e: unknown): e is ApiFailure => e instanceof ApiFailure;

export async function api<T = unknown>(method: string, url: string, body?: unknown, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal: ctrl.signal, cache: 'no-store' });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error).name === 'AbortError';
    throw new ApiFailure({ status: 0, code: aborted ? 'TIMEOUT' : 'NETWORK', error: aborted ? '通信がタイムアウトしました（20秒）。電波状況を確認してもう一度お試しください' : '通信できませんでした。電波状況（Wi-Fi・4G）を確認してもう一度お試しください' });
  }
  clearTimeout(timer);
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const d = (data ?? {}) as Partial<ApiError>;
    throw new ApiFailure({ ...d, status: res.status, code: d.code ?? `HTTP_${res.status}`, error: d.error ?? (res.status === 404 ? 'APIが見つかりません（サーバーの版が古い可能性）' : `サーバーエラー（${res.status}）`) });
  }
  return data as T;
}
export const get = <T,>(url: string) => api<T>('GET', url);
export const post = <T,>(url: string, body: unknown) => api<T>('POST', url, body);
export const put = <T,>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T,>(url: string, body?: unknown) => api<T>('DELETE', url, body ?? {});

export function errorText(e: unknown): string {
  if (isApiFailure(e)) return e.info.error;
  if (e instanceof Error) return e.message;
  return String(e);
}
export function errorCode(e: unknown): string {
  return isApiFailure(e) ? e.info.code : 'UNKNOWN';
}
/** 起動PIN が必要なエラーか */
export const needsGate = (e: unknown) => isApiFailure(e) && e.info.code === 'GATE_REQUIRED';
