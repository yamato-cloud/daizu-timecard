/**
 * マイページ：自分の記録（月別一覧・修正・取消・打刻忘れの追加）・有給申請・暗証番号変更。
 * 期限・本人判定はサーバー。画面はサーバーの可否と理由を表示するだけ。
 */
import './style.css';
import { get, post, put, del, errorText, isApiFailure, needsGate } from './lib/api.js';
import { ensureGate } from './lib/gate.js';
import { $, el, toast, busy, openModal, pinPad, fmtDateJa, todayYmd, STATUS_JA, minToHm } from './lib/ui.js';
import { shiftForm, type LocationInfo } from './lib/shift-form.js';

interface Staff { id: string; employee_id: string | null; staff_name: string; staff_kana: string; has_pin: boolean }
interface Boot { version: string; staff: Staff[]; locations: LocationInfo[] }
interface Rec { id: string; work_date: string; status: string; clock_in: string | null; clock_out: string | null; clock_out_date: string | null; overnight: boolean; location_name: string | null; location_code: string | null;
  break_minutes: number; night_break_minutes: number; work_minutes: number | null; night_minutes: number | null; travel_km: number; travel_fee: number; allowance_amount: number; allowance_note: string | null; meal_count: number; meal_fee: number;
  leave_type: string | null; leave_days: number | null; leave_reason: string | null; staff_comment: string | null; correction_reason: string | null; reasons: Record<string, { label: string; reason: string }>; self_editable: boolean; deadline: string }

const app = $('#app');
let boot: Boot;
let me: { id: string; staff_name: string; employee_id: string | null } | null = null;
let publicSettings = { travel_fee_per_km: 20, meal_unit_price: 250 };

async function main() {
  try {
    await ensureGate(app);
    boot = await get<Boot>('/api/my/bootstrap');
    try { const k = await get<{ settings: Record<string, string> }>('/api/kiosk/bootstrap'); publicSettings = { travel_fee_per_km: Number(k.settings['travel_fee_per_km']) || 20, meal_unit_price: Number(k.settings['meal_unit_price']) || 250 }; } catch { /* 既定値のまま */ }
  } catch (e) {
    if (needsGate(e)) { location.reload(); return; }
    app.innerHTML = ''; app.append(el('div', { class: 'card' }, el('div', { class: 'state error' }, el('div', { text: errorText(e) }), el('button', { class: 'btn', type: 'button', text: 'もう一度読み込む', onclick: () => location.reload() }))));
    return;
  }
  const hash = location.hash.replace('#', '');
  if (hash === 'pin') { renderPinChange(); return; }
  const session = await get<{ staff: typeof me }>('/api/my/me').catch(() => null);
  if (session?.staff) { me = session.staff; renderHome(hash === 'leave' ? 'leave' : 'records'); } else renderLogin(hash === 'leave' ? 'leave' : 'records');
}

// ---------- ログイン ----------
function staffPicker(onPick: (s: Staff) => void): HTMLElement {
  const search = el('input', { type: 'text', placeholder: '名前・よみがなで検索', inputmode: 'search', 'aria-label': '名前で検索' }) as HTMLInputElement;
  const list = el('div', { class: 'list' });
  const render = () => {
    const v = search.value.trim();
    list.innerHTML = '';
    const hit = boot.staff.filter((s) => !v || s.staff_name.includes(v) || s.staff_kana.includes(v));
    if (!hit.length) list.append(el('div', { class: 'state', text: '該当する名前がありません' }));
    for (const s of hit) {
      const b = el('button', { type: 'button', class: 'item selectable' }, el('div', { class: 'grow' }, el('div', { class: 'name', text: s.staff_name }), el('div', { class: 'sub', text: s.staff_kana })), el('span', { class: 'tag', text: '選ぶ ›' }));
      b.addEventListener('click', () => onPick(s));
      list.append(b);
    }
  };
  search.addEventListener('input', render); render();
  return el('div', {}, search, el('div', { class: 'mb' }), list);
}
function renderLogin(next: 'records' | 'leave') {
  app.innerHTML = '';
  const body = el('div');
  app.append(el('div', { class: 'topbar' }, el('div', { class: 'title', text: '自分の記録' }), el('a', { class: 'btn ghost', href: '/', text: '← 打刻画面へ', style: 'width:auto' })), el('div', { class: 'card' }, body));
  const step1 = () => { body.innerHTML = ''; body.append(el('p', { class: 'muted', text: '自分の名前を選んでください' }), staffPicker(step2)); };
  const step2 = (s: Staff) => {
    body.innerHTML = '';
    const err = el('div', { class: 'notice danger hidden', role: 'alert' });
    const pad = pinPad(async (pin) => {
      try {
        const r = await post<{ staff: typeof me }>('/api/my/login', { staff_id: s.id, pin });
        me = r.staff; renderHome(next);
      } catch (e) { pad.reset(); err.textContent = errorText(e); err.classList.remove('hidden'); }
    }, { label: `${s.staff_name} さんの暗証番号（4桁）` });
    body.append(el('h2', { text: s.staff_name }), err, pad.root, el('button', { type: 'button', class: 'btn ghost', text: '← 名前を選び直す', onclick: step1 }));
    pad.focus();
  };
  step1();
}

// ---------- ホーム（月別一覧） ----------
let ym = todayYmd().slice(0, 7);
let listEl: HTMLElement;
function shiftYm(n: number) { const [y, m] = ym.split('-').map(Number); const d = new Date(y!, m! - 1 + n, 1); ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function renderHome(tab: 'records' | 'leave') {
  app.innerHTML = '';
  const logout = el('button', { type: 'button', class: 'btn ghost', text: 'ログアウト', style: 'width:auto;min-height:36px' });
  logout.addEventListener('click', async () => { await post('/api/my/logout', {}); me = null; renderLogin('records'); });
  app.append(el('div', { class: 'topbar' }, el('div', {}, el('div', { class: 'title', text: `${me!.staff_name} さん` }), el('a', { href: '/', class: 'small', text: '← 打刻画面へ' })), logout));
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const mk = (id: 'records' | 'leave', label: string) => { const b = el('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === id), text: label }); b.addEventListener('click', () => renderHome(id)); return b; };
  tabs.append(mk('records', '勤務記録'), mk('leave', '有給申請'));
  app.append(tabs);
  if (tab === 'leave') { renderLeave(); return; }
  const prev = el('button', { type: 'button', class: 'btn', text: '‹ 前の月', style: 'width:auto' });
  const nextB = el('button', { type: 'button', class: 'btn', text: '次の月 ›', style: 'width:auto' });
  const title = el('h2', { class: 'center', style: 'margin:0' });
  prev.addEventListener('click', () => { shiftYm(-1); loadRecords(title); });
  nextB.addEventListener('click', () => { shiftYm(1); loadRecords(title); });
  const addBtn = el('button', { type: 'button', class: 'btn primary', text: '＋ 打刻忘れの記録を追加する' });
  addBtn.addEventListener('click', () => openAdd());
  listEl = el('div');
  app.append(el('div', { class: 'card' }, el('div', { class: 'row', style: 'align-items:center' }, prev, title, nextB), el('p', { class: 'muted small center mt', text: '修正・取消ができるのは「当月分」と「翌月7日までの前月分」です。それ以降は管理者にご相談ください' }), listEl), el('div', { class: 'card' }, addBtn));
  loadRecords(title);
}
async function loadRecords(title: HTMLElement) {
  const [y, m] = ym.split('-');
  title.textContent = `${y}年${Number(m)}月`;
  listEl.innerHTML = '';
  listEl.append(el('div', { class: 'state loading', text: '読み込み中…' }));
  try {
    const r = await get<{ records: Rec[] }>(`/api/my/records?ym=${ym}`);
    renderRecords(r.records);
  } catch (e) {
    if (isApiFailure(e) && e.info.status === 401) { renderLogin('records'); return; }
    listEl.innerHTML = '';
    const b = el('button', { type: 'button', class: 'btn', text: 'もう一度読み込む' }); b.addEventListener('click', () => loadRecords(title));
    listEl.append(el('div', { class: 'state error' }, el('div', { text: `記録を取得できませんでした：${errorText(e)}` }), b));
  }
}
function renderRecords(recs: Rec[]) {
  listEl.innerHTML = '';
  if (!recs.length) { listEl.append(el('div', { class: 'state', text: 'この月の記録はありません（0件）' })); return; }
  const totalWork = recs.filter((r) => r.status === 'DONE').reduce((s, r) => s + (r.work_minutes ?? 0), 0);
  const leaveDays = recs.filter((r) => r.status.startsWith('PAID_LEAVE')).reduce((s, r) => s + (r.leave_days ?? 0), 0);
  listEl.append(el('div', { class: 'notice info', text: `勤務 ${recs.filter((r) => r.status === 'DONE').length}回・実働 ${minToHm(totalWork)}${leaveDays ? `・有給 ${leaveDays}日` : ''}` }));
  const list = el('div', { class: 'list' });
  for (const r of recs) {
    const isLeave = r.status.startsWith('PAID_LEAVE');
    const tagClass = r.status === 'OVERDUE' ? 'overdue' : r.status === 'DONE' ? 'done' : isLeave ? 'leave' : '';
    const sub = isLeave ? (r.leave_reason ? `理由：${r.leave_reason}` : '') : `${r.clock_in ?? ''} → ${r.clock_out ?? '（未退勤）'}${r.overnight ? '（翌日）' : ''}　${r.location_name ?? ''}${r.status === 'DONE' ? `　実働${minToHm(r.work_minutes)}` : ''}`;
    const b = el('button', { type: 'button', class: 'item selectable' },
      el('div', { class: 'grow' }, el('div', { class: 'name', text: fmtDateJa(r.work_date) }), el('div', { class: 'sub', text: sub }), r.correction_reason ? el('div', { class: 'sub', text: `修正理由：${r.correction_reason}` }) : null),
      el('span', { class: `tag ${tagClass}`, text: STATUS_JA[r.status] ?? r.status }));
    b.addEventListener('click', () => openDetail(r));
    list.append(b);
  }
  listEl.append(list);
}

function openDetail(r: Rec) {
  const body = el('div');
  const m = openModal(`${fmtDateJa(r.work_date)} の記録`, body);
  const isLeave = r.status.startsWith('PAID_LEAVE');
  const kv = el('dl', { class: 'kv' });
  const row = (k: string, v: string) => kv.append(el('dt', { text: k }), el('dd', { text: v }));
  row('状態', STATUS_JA[r.status] ?? r.status);
  if (isLeave) { row('有給', `${r.leave_type === 'am' ? '午前半休' : r.leave_type === 'pm' ? '午後半休' : '全休'}（${r.leave_days ?? ''}日）`); if (r.leave_reason) row('理由', r.leave_reason); }
  else {
    row('事業所', r.location_name ?? '');
    row('出勤', r.clock_in ?? '');
    row('退勤', r.clock_out ? `${r.clock_out}${r.overnight ? `（翌日 ${r.clock_out_date}）` : ''}` : '（未退勤）');
    if (r.status === 'DONE') { row('休憩', `通常 ${r.break_minutes}分 ／ 深夜 ${r.night_break_minutes}分`); row('実働', `${minToHm(r.work_minutes)}（深夜 ${minToHm(r.night_minutes)}）`); if (r.travel_km) row('移動', `${r.travel_km}km（${r.travel_fee}円）`); if (r.allowance_amount) row('手当', `${r.allowance_amount}円 ${r.allowance_note ?? ''}`); if (r.meal_fee) row('まかない', `${r.meal_fee}円`); }
    if (r.staff_comment) row('備考', r.staff_comment);
    for (const [, v] of Object.entries(r.reasons ?? {})) row('確認理由', `${v.label}：${v.reason}`);
  }
  if (r.correction_reason) row('修正理由', r.correction_reason);
  body.append(kv);
  if (!r.self_editable) body.append(el('div', { class: 'notice warn mt', text: `この記録の本人による修正・取消の期限（${r.deadline}）は過ぎています。変更が必要なときは管理者にご相談ください` }));
  else {
    const actions = el('div', { class: 'mt' });
    if (r.status === 'DONE') {
      const e = el('button', { type: 'button', class: 'btn primary', text: 'この記録を修正する' });
      e.addEventListener('click', () => { m.close(); openEdit(r); });
      actions.append(e, el('div', { class: 'mb' }));
    }
    const c = el('button', { type: 'button', class: 'btn danger', text: isLeave ? 'この有給申請を取り消す' : 'この記録を取り消す' });
    c.addEventListener('click', async () => {
      if (!confirm(`${fmtDateJa(r.work_date)} の記録を取り消します。よろしいですか？`)) return;
      try { const res = await busy(c, '送信中…', () => del<{ message: string }>(`/api/my/records/${r.id}`, { reason: '本人による取消' })); m.close(); toast(res.message, 'success'); loadRecords($('h2.center')); }
      catch (e) { toast(errorText(e), 'error'); }
    });
    actions.append(c);
    body.append(actions);
  }
}
function openEdit(r: Rec) {
  const body = el('div');
  const m = openModal(`${fmtDateJa(r.work_date)} の記録を修正`, body);
  body.append(shiftForm({ mode: 'edit', record: r as never, locations: boot.locations, settings: publicSettings, submit: (p) => put(`/api/my/records/${r.id}`, p), onDone: (res) => { m.close(); toast(res.message ?? '修正しました', 'success'); loadRecords($('h2.center')); } }));
}
function openAdd() {
  const body = el('div');
  const m = openModal('打刻忘れの記録を追加', body);
  body.append(el('div', { class: 'notice info', text: '出勤・退勤の打刻を忘れた日の記録を追加します。日付を忘れた日に直してください（今日のままだと確認が出ます）' }));
  body.append(shiftForm({ mode: 'add', record: { work_date: todayYmd(), clock_in: '' }, locations: boot.locations, settings: publicSettings, submit: (p) => post('/api/my/records', p), onDone: (res) => { m.close(); toast(res.message ?? '追加しました', 'success'); loadRecords($('h2.center')); } }));
}

// ---------- 有給 ----------
function renderLeave() {
  const form = el('form', { novalidate: true });
  const date = el('input', { type: 'date', name: 'work_date', value: todayYmd(), required: true }) as HTMLInputElement;
  const type = el('select', { name: 'type' }, el('option', { value: 'full', text: '全休（1.0日）' }), el('option', { value: 'am', text: '午前半休（0.5日）' }), el('option', { value: 'pm', text: '午後半休（0.5日）' })) as HTMLSelectElement;
  const reason = el('input', { type: 'text', name: 'reason', placeholder: '任意', maxlength: '200' }) as HTMLInputElement;
  const btn = el('button', { type: 'submit', class: 'btn primary big', text: '有給を申請する' }) as HTMLButtonElement;
  form.append(el('label', { class: 'field' }, el('span', { text: '日付' }), date), el('label', { class: 'field' }, el('span', { text: '種別' }), type), el('label', { class: 'field' }, el('span', { text: '理由' }), reason), btn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { const r = await busy(btn, '送信中…', () => post<{ message: string }>('/api/my/leave', { work_date: date.value, type: type.value, reason: reason.value })); toast(r.message, 'success', 6000); reason.value = ''; }
    catch (e) { toast(errorText(e), 'error'); }
  });
  app.append(el('div', { class: 'card' }, el('h2', { text: '有給申請' }), el('p', { class: 'muted small', text: '同じ日に2件は登録できません。登録した有給は「勤務記録」の月から確認・取消できます' }), form));
}

// ---------- 暗証番号変更（ログイン不要） ----------
function renderPinChange() {
  app.innerHTML = '';
  app.append(el('div', { class: 'topbar' }, el('div', { class: 'title', text: '暗証番号の変更' }), el('a', { class: 'btn ghost', href: '/', text: '← 打刻画面へ', style: 'width:auto' })));
  const body = el('div');
  app.append(el('div', { class: 'card' }, body));
  const step1 = () => { body.innerHTML = ''; body.append(el('p', { class: 'muted', text: '自分の名前を選んでください' }), staffPicker(step2)); };
  const err = el('div', { class: 'notice danger hidden', role: 'alert' });
  const showErr = (msg: string) => { err.textContent = msg; err.classList.remove('hidden'); };
  const step2 = (s: Staff, message?: string) => {
    body.innerHTML = '';
    err.classList.add('hidden');
    if (message) showErr(message);
    let current = '';
    const padNew = pinPad(async (np) => {
      try { const r = await post<{ message: string }>('/api/my/pin', { staff_id: s.id, current_pin: current, new_pin: np }); toast(r.message, 'success'); location.href = '/'; }
      catch (e) {
        padNew.reset();
        // 現在のPINが違う等 → 現在のPIN入力からやり直し（理由は表示したまま）。新PINの形式エラーはその場で
        if (isApiFailure(e) && e.info.code !== 'BAD_PIN') step2(s, errorText(e)); else showErr(errorText(e));
      }
    }, { label: '新しい暗証番号（4桁）' });
    const padCur = pinPad((p) => { current = p; body.innerHTML = ''; err.classList.add('hidden'); body.append(el('h2', { text: s.staff_name }), err, padNew.root); padNew.focus(); }, { label: '現在の暗証番号（4桁）' });
    body.append(el('h2', { text: s.staff_name }), err, padCur.root, el('button', { type: 'button', class: 'btn ghost', text: '← 名前を選び直す', onclick: () => step1() }));
    padCur.focus();
  };
  step1();
}

main();
