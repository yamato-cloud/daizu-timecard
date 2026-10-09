/** 画面部品：トースト（aria-live）、モーダル、ボタン通信中、テンキー、整形 */

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`要素が見つかりません: ${sel}`);
  return el;
};
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => Array.from(root.querySelectorAll<T>(sel));

export type Attrs = Record<string, string | boolean | number | null | undefined | ((ev: Event) => void)>;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') { e.addEventListener(k.replace(/^on/, ''), v as EventListener); continue; }
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'html') e.innerHTML = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
export const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- トースト ----------
let toastRoot: HTMLElement | null = null;
export function toast(message: string, kind: 'success' | 'error' | 'info' = 'info', ms = kind === 'error' ? 7000 : 3500): HTMLElement {
  if (!toastRoot) { toastRoot = el('div', { class: 'toasts', 'aria-live': 'polite', role: 'status' }); document.body.append(toastRoot); }
  const t = el('div', { class: `toast ${kind}`, text: message });
  while (toastRoot.children.length >= 2) toastRoot.firstElementChild?.remove();
  toastRoot.append(t);
  const close = () => t.remove();
  t.addEventListener('click', close);
  if (ms > 0) setTimeout(close, ms);
  return t;
}

// ---------- ボタンの通信中表示・二重送信防止 ----------
export async function busy<T>(btn: HTMLButtonElement | null, label: string, fn: () => Promise<T>): Promise<T> {
  if (btn?.disabled) throw new Error('処理中です');
  const orig = btn?.textContent ?? '';
  if (btn) { btn.disabled = true; btn.textContent = label; btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.textContent = orig; btn.removeAttribute('aria-busy'); } }
}

// ---------- モーダル ----------
export function openModal(title: string, body: HTMLElement, opts: { onClose?: () => void; closeLabel?: string } = {}): { close: () => void; sheet: HTMLElement } {
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const closeBtn = el('button', { class: 'btn ghost', type: 'button', text: opts.closeLabel ?? '閉じる' });
  sheet.append(el('div', { class: 'sheet-head' }, el('h2', { text: title }), closeBtn), body);
  const wrap = el('div', { class: 'modal' }, sheet);
  const close = () => { wrap.remove(); document.body.style.overflow = ''; opts.onClose?.(); };
  closeBtn.addEventListener('click', close);
  document.body.append(wrap);
  document.body.style.overflow = 'hidden';
  return { close, sheet };
}

// ---------- 入力欄のエラー表示 ----------
export function markInvalid(root: ParentNode, field: string | undefined, message?: string): void {
  $$('[aria-invalid]', root).forEach((e) => e.removeAttribute('aria-invalid'));
  if (!field) return;
  const target = root.querySelector<HTMLElement>(`[name="${field}"]`);
  if (target) { target.setAttribute('aria-invalid', 'true'); target.focus(); target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  if (message) toast(message, 'error');
}

// ---------- テンキー（4桁PIN） ----------
export function pinPad(onComplete: (pin: string) => void, opts: { label?: string } = {}): { root: HTMLElement; reset: () => void; focus: () => void } {
  let pin = '';
  const dots = el('div', { class: 'pin-dots', 'aria-hidden': 'true' }, ...[0, 1, 2, 3].map(() => el('span')));
  const sr = el('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '4', autocomplete: 'off', 'aria-label': opts.label ?? '暗証番号 4桁', style: 'position:absolute;opacity:0;height:1px;width:1px;' }) as HTMLInputElement;
  const render = () => { dots.querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', i < pin.length)); };
  const push = (d: string) => { if (pin.length >= 4) return; pin += d; render(); if (pin.length === 4) { const p = pin; setTimeout(() => onComplete(p), 60); } };
  const pad = el('div', { class: 'keypad' });
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '消す', '0', '←']) {
    const b = el('button', { type: 'button', text: k, 'aria-label': k === '←' ? '1文字消す' : k === '消す' ? '全部消す' : k });
    b.addEventListener('click', () => { if (k === '消す') { pin = ''; } else if (k === '←') { pin = pin.slice(0, -1); } else push(k); render(); });
    pad.append(b);
  }
  sr.addEventListener('input', () => { pin = sr.value.replace(/\D/g, '').slice(0, 4); render(); if (pin.length === 4) { const p = pin; setTimeout(() => onComplete(p), 60); } });
  const root = el('div', {}, opts.label ? el('p', { class: 'center muted', text: opts.label }) : null, dots, sr, pad);
  return { root, reset: () => { pin = ''; sr.value = ''; render(); }, focus: () => sr.focus() };
}

// ---------- 整形 ----------
export const pad2 = (n: number) => String(n).padStart(2, '0');
export function nowJst(): Date { return new Date(); }
export function fmtDateJa(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const w = '日月火水木金土'[new Date(y!, m! - 1, d!).getDay()];
  return `${m}/${d}（${w}）`;
}
export function todayYmd(): string { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function nowHHMM(): string { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
export function addDaysYmd(ymd: string, n: number): string { const [y, m, d] = ymd.split('-').map(Number); const dt = new Date(y!, m! - 1, d! + n); return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; }
export function minToHm(min: number | null | undefined): string { if (min === null || min === undefined) return '—'; return `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}`; }
export const STATUS_JA: Record<string, string> = { WORKING: '勤務中', OVERDUE: '退勤忘れ', DONE: '退勤済み', PAID_LEAVE: '有給全休', PAID_LEAVE_AM: '有給午前半休', PAID_LEAVE_PM: '有給午後半休' };
