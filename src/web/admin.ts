/**
 * 管理画面（大和さん・新井さん）。Google ログイン。スマホからも使える（390px）。
 * タブ：勤怠／スタッフ／事業所／給与データ／異常検知／設定／定期処理・ログ
 */
import './style.css';
import { get, post, put, del, errorText, isApiFailure } from './lib/api.js';
import { $, el, toast, busy, openModal, fmtDateJa, todayYmd, STATUS_JA, minToHm, fmtTs, LEAVE_JA } from './lib/ui.js';
import { shiftForm, type LocationInfo } from './lib/shift-form.js';

interface Me { logged_in: boolean; email: string | null; label: string | null; google_enabled: boolean; emergency_enabled: boolean }
interface StaffA { id: string; employee_id: string | null; staff_name: string; staff_kana: string; active: boolean; has_pin: boolean; email: string | null; main_department: string }
interface Loc extends LocationInfo { id: string; sort_order: number; active: boolean }
interface Rec { id: string; work_date: string; staff_id: string; staff_name: string; employee_id: string | null; location_name: string | null; location_code: string | null; department: string | null; clock_in: string | null; clock_out: string | null; clock_out_date: string | null; overnight: boolean; status: string;
  break_minutes: number; night_break_minutes: number; work_minutes: number | null; night_minutes: number | null; travel_km: number; travel_fee: number; allowance_amount: number; allowance_note: string | null; meal_count: number; meal_fee: number; alcohol_check: string | null;
  leave_type: string | null; leave_days: number | null; leave_reason: string | null; staff_comment: string | null; staff_comment_full: string; correction_reason: string | null; reasons: Record<string, { label: string; reason: string }>; deleted_at: string | null; updated_by: string | null }

const app = $('#app');
let me: Me;
let staffList: StaffA[] = [];
let locations: Loc[] = [];
let settings: Record<string, string> = {};
const fs = () => ({ travel_fee_per_km: Number(settings['travel_fee_per_km']) || 20, meal_unit_price: Number(settings['meal_unit_price']) || 250 });
type Tab = 'attendance' | 'staff' | 'locations' | 'payroll' | 'anomalies' | 'settings' | 'jobs';
const TABS: Array<[Tab, string]> = [['attendance', '勤怠'], ['staff', 'スタッフ'], ['locations', '事業所'], ['payroll', '給与データ'], ['anomalies', '異常検知'], ['settings', '設定'], ['jobs', '定期処理・ログ']];
let tab: Tab = (location.hash.replace('#', '') as Tab) || 'attendance';
let content: HTMLElement;

async function main() {
  me = await get<Me>('/api/auth/admin/me');
  if (!me.logged_in) { renderLogin(); return; }
  await loadMasters();
  renderShell();
}
async function loadMasters() {
  const [s, l, st] = await Promise.all([get<{ staff: StaffA[] }>('/api/admin/staff'), get<{ locations: Loc[] }>('/api/admin/locations'), get<{ settings: Record<string, string> }>('/api/admin/settings')]);
  staffList = s.staff; locations = l.locations; settings = st.settings;
}

function renderLogin() {
  app.innerHTML = '';
  const err = new URLSearchParams(location.search).get('login_error');
  const card = el('div', { class: 'card' }, el('h1', { text: '管理画面ログイン' }));
  if (err) card.append(el('div', { class: 'notice danger', role: 'alert', text: err }));
  if (me.google_enabled) card.append(el('a', { class: 'btn primary big', href: '/api/auth/google/start', text: 'Google アカウントでログイン' }), el('p', { class: 'muted small mt', text: '管理者として登録されたメールアドレス（2名）だけがログインできます' }));
  else card.append(el('div', { class: 'notice warn', text: 'Google ログインが未設定です（サーバーの GOOGLE_CLIENT_ID）。設定するまでは下の緊急ログインを使ってください' }));
  if (me.emergency_enabled) {
    const tok = el('input', { type: 'password', name: 'token', placeholder: '緊急ログイン用トークン', autocomplete: 'off' }) as HTMLInputElement;
    const btn = el('button', { type: 'button', class: 'btn', text: '緊急ログイン' }) as HTMLButtonElement;
    btn.addEventListener('click', async () => { try { await busy(btn, '確認中…', () => post('/api/auth/emergency', { token: tok.value, email: 'yamato@daizu.info' })); location.href = '/admin.html'; } catch (e) { toast(errorText(e), 'error'); } });
    card.append(el('details', { class: 'mt' }, el('summary', { class: 'muted', text: 'Google が使えないときの緊急ログイン' }), el('label', { class: 'field mt' }, el('span', { text: 'トークン（サーバーの .env の ADMIN_EMERGENCY_TOKEN）' }), tok), btn));
  }
  card.append(el('p', { class: 'mt' }, el('a', { href: '/', text: '← 打刻画面へ' })));
  app.append(card);
}

function renderShell() {
  app.innerHTML = '';
  const logout = el('button', { type: 'button', class: 'btn ghost', text: 'ログアウト', style: 'width:auto;min-height:36px' });
  logout.addEventListener('click', async () => { await post('/api/auth/logout', {}); location.href = '/admin.html'; });
  app.append(el('div', { class: 'topbar' }, el('div', {}, el('div', { class: 'title', text: '管理画面' }), el('div', { class: 'muted small', text: me.label ?? me.email ?? '' })), logout));
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  for (const [id, label] of TABS) { const b = el('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === id), text: label }); b.addEventListener('click', () => { tab = id; location.hash = id; renderShell(); }); tabs.append(b); }
  content = el('div');
  app.append(tabs, content);
  ({ attendance: renderAttendance, staff: renderStaff, locations: renderLocations, payroll: renderPayroll, anomalies: renderAnomalies, settings: renderSettings, jobs: renderJobs })[tab]();
}
const loading = () => el('div', { class: 'state loading', text: '読み込み中…' });
const errorState = (e: unknown, retry: () => void) => { const b = el('button', { type: 'button', class: 'btn', text: 'もう一度読み込む' }); b.addEventListener('click', retry); return el('div', { class: 'state error' }, el('div', { text: errorText(e) }), b); };
const field = (label: string, input: HTMLElement, hint?: string) => el('label', { class: 'field' }, el('span', { text: label }), input, hint ? el('div', { class: 'muted small', text: hint }) : null);
const staffSelect = (name: string, value = '') => { const s = el('select', { name }, el('option', { value: '', text: '（すべて）' })) as HTMLSelectElement; for (const x of staffList) s.append(el('option', { value: x.id, text: `${x.staff_name}${x.active ? '' : '（無効）'}`, selected: x.id === value })); return s; };
const locSelect = (name: string, value = '') => { const s = el('select', { name }, el('option', { value: '', text: '（すべて）' })) as HTMLSelectElement; for (const x of locations) s.append(el('option', { value: x.location_code, text: x.location_name, selected: x.location_code === value })); return s; };

// ---------- 勤怠 ----------
let attFilter = { ym: todayYmd().slice(0, 7), staff_id: '', location_code: '', status: '' };
function renderAttendance() {
  content.innerHTML = '';
  const ymIn = el('input', { type: 'month', name: 'ym', value: attFilter.ym }) as HTMLInputElement;
  const stSel = staffSelect('staff_id', attFilter.staff_id);
  const locSel = locSelect('location_code', attFilter.location_code);
  const statusSel = el('select', { name: 'status' }, el('option', { value: '', text: '（すべて）' }), ...Object.entries(STATUS_JA).map(([k, v]) => el('option', { value: k, text: v, selected: attFilter.status === k }))) as HTMLSelectElement;
  const list = el('div');
  const load = async () => {
    attFilter = { ym: ymIn.value, staff_id: stSel.value, location_code: locSel.value, status: statusSel.value };
    list.innerHTML = ''; list.append(loading());
    try {
      const qs = new URLSearchParams(); if (attFilter.ym) qs.set('ym', attFilter.ym); if (attFilter.staff_id) qs.set('staff_id', attFilter.staff_id); if (attFilter.location_code) qs.set('location_code', attFilter.location_code); if (attFilter.status) qs.set('status', attFilter.status);
      const r = await get<{ records: Rec[] }>(`/api/admin/attendance?${qs}`);
      list.innerHTML = '';
      if (!r.records.length) { list.append(el('div', { class: 'state', text: '該当する記録はありません（0件）' })); return; }
      list.append(el('p', { class: 'muted small', text: `${r.records.length}件（押すと詳細・編集）` }));
      const ul = el('div', { class: 'list' });
      for (const x of r.records) {
        const isLeave = x.status.startsWith('PAID_LEAVE');
        const sub = isLeave ? `有給 ${x.leave_type === 'am' ? '午前' : x.leave_type === 'pm' ? '午後' : '全休'}` : `${x.clock_in ?? ''}→${x.clock_out ?? '未'}${x.overnight ? '(翌)' : ''} ${x.location_name ?? ''}${x.status === 'DONE' ? ` 実働${minToHm(x.work_minutes)}` : ''}`;
        const b = el('button', { type: 'button', class: 'item selectable' }, el('div', { class: 'grow' }, el('div', { class: 'name', text: `${fmtDateJa(x.work_date)} ${x.staff_name}` }), el('div', { class: 'sub', text: sub })), el('span', { class: `tag ${x.status === 'OVERDUE' ? 'overdue' : x.status === 'DONE' ? 'done' : isLeave ? 'leave' : ''}`, text: STATUS_JA[x.status] ?? x.status }));
        b.addEventListener('click', () => openAdminDetail(x, load));
        ul.append(b);
      }
      list.append(ul);
    } catch (e) { list.innerHTML = ''; list.append(errorState(e, load)); }
  };
  [ymIn, stSel, locSel, statusSel].forEach((i) => i.addEventListener('change', load));
  const addBtn = el('button', { type: 'button', class: 'btn primary', text: '＋ 記録を追加（退勤済み）' }); addBtn.addEventListener('click', () => openAdminAdd(load));
  const leaveBtn = el('button', { type: 'button', class: 'btn', text: '＋ 有給を追加' }); leaveBtn.addEventListener('click', () => openAdminLeave(load));
  const openBtn = el('button', { type: 'button', class: 'btn', text: '＋ 出勤のみ（勤務中）を追加' }); openBtn.addEventListener('click', () => openAdminOpen(load));
  content.append(el('div', { class: 'card' }, el('div', { class: 'grid2' }, field('月', ymIn), field('状態', statusSel), field('スタッフ', stSel), field('事業所', locSel)), el('div', { class: 'row' }, addBtn, leaveBtn), el('div', { class: 'mt' }, openBtn)), el('div', { class: 'card' }, list));
  load();
}
function openAdminDetail(x: Rec, reload: () => void) {
  const body = el('div');
  const m = openModal(`${fmtDateJa(x.work_date)} ${x.staff_name}`, body);
  const kv = el('dl', { class: 'kv' });
  const row = (k: string, v: string) => kv.append(el('dt', { text: k }), el('dd', { text: v }));
  row('状態', STATUS_JA[x.status] ?? x.status);
  if (x.status.startsWith('PAID_LEAVE')) { row('有給', `${LEAVE_JA[x.leave_type ?? 'full'] ?? x.leave_type} ${x.leave_days ?? ''}日`); row('理由', x.leave_reason ?? ''); }
  else {
    row('事業所', `${x.location_name ?? ''}（${x.department ?? ''}）`); row('出勤', x.clock_in ?? ''); row('退勤', x.clock_out ? `${x.clock_out}${x.overnight ? `（翌日 ${x.clock_out_date}）` : ''}` : '（未退勤）');
    row('休憩', `通常 ${x.break_minutes} ／ 深夜 ${x.night_break_minutes}`); row('実働', `${x.work_minutes ?? '—'}分（深夜 ${x.night_minutes ?? '—'}分）`);
    row('移動', `${x.travel_km}km ${x.travel_fee}円`); row('手当', `${x.allowance_amount}円 ${x.allowance_note ?? ''}`); row('まかない', `${x.meal_fee}円（${x.meal_count}食）`);
    if (x.alcohol_check) row('アルコール', x.alcohol_check);
    row('備考', x.staff_comment ?? '');
    for (const [, v] of Object.entries(x.reasons ?? {})) row('確認理由', `${v.label}：${v.reason}`);
    row('CSV備考', x.staff_comment_full);
  }
  row('修正理由', x.correction_reason ?? ''); row('最終更新', x.updated_by ?? '');
  body.append(kv);
  const actions = el('div', { class: 'mt' });
  if (x.deleted_at) {
    const r = el('button', { type: 'button', class: 'btn', text: '復元する' }) as HTMLButtonElement;
    r.addEventListener('click', async () => { try { await busy(r, '復元中…', () => post(`/api/admin/attendance/${x.id}/restore`, {})); m.close(); toast('復元しました', 'success'); reload(); } catch (e) { toast(errorText(e), 'error'); } });
    actions.append(el('div', { class: 'notice warn', text: `取消済み（${fmtTs(x.deleted_at)}）` }), r);
  } else {
    if (x.status === 'DONE') { const e = el('button', { type: 'button', class: 'btn primary', text: '編集する' }); e.addEventListener('click', () => { m.close(); openAdminEdit(x, reload); }); actions.append(e, el('div', { class: 'mb' })); }
    if (x.status === 'WORKING' || x.status === 'OVERDUE') {
      const co = el('button', { type: 'button', class: 'btn out', text: '退勤を入力して締める' });
      co.addEventListener('click', () => { m.close(); openAdminClose(x, reload); });
      const ci = el('button', { type: 'button', class: 'btn', text: '出勤日時・事業所を直す' });
      ci.addEventListener('click', () => { m.close(); openAdminFixOpen(x, reload); });
      actions.append(co, el('div', { class: 'mb' }), ci, el('div', { class: 'mb' }));
    }
    if (x.status.startsWith('PAID_LEAVE')) { const e = el('button', { type: 'button', class: 'btn primary', text: '有給の種別・理由を直す' }); e.addEventListener('click', () => { m.close(); openAdminLeaveEdit(x, reload); }); actions.append(e, el('div', { class: 'mb' })); }
    const d = el('button', { type: 'button', class: 'btn danger', text: '削除（取消）する' }) as HTMLButtonElement;
    d.addEventListener('click', async () => { const reason = prompt('削除の理由を入力してください'); if (reason === null) return; try { await busy(d, '削除中…', () => del(`/api/admin/attendance/${x.id}`, { reason })); m.close(); toast('削除しました', 'success'); reload(); } catch (e) { toast(errorText(e), 'error'); } });
    actions.append(d);
  }
  body.append(actions);
  get<{ audit: Array<{ ts: string; actor_label: string; action: string }> }>(`/api/admin/attendance/${x.id}`).then((r) => {
    body.append(el('h3', { class: 'mt', text: '変更履歴' }), el('div', { class: 'small muted' }, ...r.audit.map((a) => el('div', { text: `${fmtTs(a.ts)} ${a.actor_label} ${a.action}` }))));
  }).catch(() => {});
}
function openAdminEdit(x: Rec, reload: () => void) {
  const body = el('div');
  const m = openModal('記録を編集', body);
  body.append(shiftForm({ mode: 'edit', record: x as never, locations, settings: fs(), allowDateAndLocation: true, submit: (p) => put(`/api/admin/attendance/${x.id}`, p), onDone: (r) => { m.close(); toast(r.message ?? '更新しました', 'success'); reload(); } }));
}
function openAdminClose(x: Rec, reload: () => void) {
  const body = el('div');
  const m = openModal(`退勤を入力：${x.staff_name}`, body);
  body.append(el('div', { class: 'notice warn', text: '管理者が代わりに退勤を入力します。実際の退勤時刻を入れてください' }));
  body.append(shiftForm({ mode: 'clockout', record: { ...x, status: 'OVERDUE' } as never, locations, settings: fs(), submitLabel: '退勤として保存',
    submit: (p) => put(`/api/admin/attendance/${x.id}`, { clock_in: (p['clock_in_fix'] as string) || x.clock_in, clock_out: p['clock_out'], clock_out_date: p['clock_out_date'], break_minutes: p['break_minutes'], night_break_minutes: p['night_break_minutes'], travel_km: p['travel_km'], comment: p['comment'], allowance_amount: p['allowance_amount'], allowance_note: p['allowance_note'], meal_count: p['meal_count'], reasons: p['reasons'], status: 'DONE', correction_reason: '管理者による退勤入力' }),
    onDone: (r) => { m.close(); toast(r.message ?? '保存しました', 'success'); reload(); } }));
}
function openAdminFixOpen(x: Rec, reload: () => void) {
  const body = el('div');
  const m = openModal('出勤日時・事業所を直す', body);
  const form = el('form', { novalidate: true });
  const d = el('input', { type: 'date', name: 'work_date', value: x.work_date }) as HTMLInputElement;
  const t = el('input', { type: 'time', name: 'clock_in', value: x.clock_in ?? '' }) as HTMLInputElement;
  const l = locSelect('location_code', x.location_code ?? '');
  const reason = el('input', { type: 'text', name: 'correction_reason', placeholder: '必須' }) as HTMLInputElement;
  const btn = el('button', { type: 'submit', class: 'btn primary', text: '保存' }) as HTMLButtonElement;
  form.append(field('出勤日', d), field('出勤時刻', t), field('事業所', l), field('修正理由', reason), btn);
  form.addEventListener('submit', async (ev) => { ev.preventDefault(); try { await busy(btn, '保存中…', () => put(`/api/admin/attendance/${x.id}`, { work_date: d.value, clock_in: t.value, location_code: l.value || undefined, correction_reason: reason.value })); m.close(); toast('保存しました', 'success'); reload(); } catch (e) { toast(errorText(e), 'error'); } });
  body.append(form);
}
function openAdminLeaveEdit(x: Rec, reload: () => void) {
  const body = el('div');
  const m = openModal('有給を直す', body);
  const form = el('form', { novalidate: true });
  const d = el('input', { type: 'date', name: 'work_date', value: x.work_date }) as HTMLInputElement;
  const t = el('select', { name: 'leave_type' }, ...[['full', '全休'], ['am', '午前半休'], ['pm', '午後半休']].map(([v, l]) => el('option', { value: v, text: l, selected: x.leave_type === v }))) as HTMLSelectElement;
  const r = el('input', { type: 'text', name: 'leave_reason', value: x.leave_reason ?? '' }) as HTMLInputElement;
  const reason = el('input', { type: 'text', name: 'correction_reason', placeholder: '必須' }) as HTMLInputElement;
  const btn = el('button', { type: 'submit', class: 'btn primary', text: '保存' }) as HTMLButtonElement;
  form.append(field('日付', d), field('種別', t), field('有給の理由', r), field('修正理由', reason), btn);
  form.addEventListener('submit', async (ev) => { ev.preventDefault(); try { await busy(btn, '保存中…', () => put(`/api/admin/attendance/${x.id}`, { work_date: d.value, leave_type: t.value, leave_reason: r.value, correction_reason: reason.value })); m.close(); toast('保存しました', 'success'); reload(); } catch (e) { toast(errorText(e), 'error'); } });
  body.append(form);
}
function openAdminAdd(reload: () => void) {
  const body = el('div');
  const m = openModal('記録を追加（退勤済み）', body);
  const st = staffSelect('staff_id'); st.options[0]!.text = 'スタッフを選ぶ';
  body.append(field('スタッフ', st));
  body.append(shiftForm({ mode: 'add', record: { work_date: todayYmd(), clock_in: '' }, locations, settings: fs(), submit: (p) => post('/api/admin/attendance', { ...p, staff_id: st.value }), onDone: (r) => { m.close(); toast(r.message ?? '追加しました', 'success'); reload(); } }));
}
function openAdminLeave(reload: () => void) {
  const body = el('div');
  const m = openModal('有給を追加（期限後も可）', body);
  const form = el('form', { novalidate: true });
  const st = staffSelect('staff_id'); st.options[0]!.text = 'スタッフを選ぶ';
  const d = el('input', { type: 'date', name: 'work_date', value: todayYmd() }) as HTMLInputElement;
  const t = el('select', { name: 'type' }, ...[['full', '全休（1.0日）'], ['am', '午前半休（0.5日）'], ['pm', '午後半休（0.5日）']].map(([v, l]) => el('option', { value: v, text: l }))) as HTMLSelectElement;
  const r = el('input', { type: 'text', name: 'reason', placeholder: '任意' }) as HTMLInputElement;
  const btn = el('button', { type: 'submit', class: 'btn primary', text: '登録' }) as HTMLButtonElement;
  form.append(field('スタッフ', st), field('日付', d), field('種別', t), field('理由', r), btn);
  form.addEventListener('submit', async (ev) => { ev.preventDefault(); try { const res = await busy(btn, '登録中…', () => post<{ message: string }>('/api/admin/leave', { staff_id: st.value, work_date: d.value, type: t.value, reason: r.value })); m.close(); toast(res.message, 'success'); reload(); } catch (e) { toast(errorText(e), 'error'); } });
  body.append(form);
}
function openAdminOpen(reload: () => void) {
  const body = el('div');
  const m = openModal('出勤のみ（勤務中）を追加', body);
  const form = el('form', { novalidate: true });
  const st = staffSelect('staff_id'); st.options[0]!.text = 'スタッフを選ぶ';
  const d = el('input', { type: 'date', name: 'work_date', value: todayYmd() }) as HTMLInputElement;
  const t = el('input', { type: 'time', name: 'clock_in' }) as HTMLInputElement;
  const l = locSelect('location_code'); l.options[0]!.text = '事業所を選ぶ';
  const btn = el('button', { type: 'submit', class: 'btn primary', text: '登録' }) as HTMLButtonElement;
  form.append(el('p', { class: 'muted small', text: '出勤を押し忘れて今も勤務中の人のために、出勤だけを記録します。退勤は本人が端末から押せます' }), field('スタッフ', st), field('事業所', l), field('出勤日', d), field('出勤時刻', t), btn);
  form.addEventListener('submit', async (ev) => { ev.preventDefault(); try { const res = await busy(btn, '登録中…', () => post<{ message: string }>('/api/admin/attendance/open', { staff_id: st.value, location_code: l.value, work_date: d.value, clock_in: t.value })); m.close(); toast(res.message, 'success'); reload(); } catch (e) { toast(errorText(e), 'error'); } });
  body.append(form);
}

// ---------- スタッフ ----------
function renderStaff() {
  content.innerHTML = '';
  const search = el('input', { type: 'text', placeholder: '氏名・かな・従業員IDで検索', inputmode: 'search' }) as HTMLInputElement;
  const showInactive = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const list = el('div', { class: 'list' });
  const render = () => {
    const v = search.value.replace(/[\s　]/g, '');
    list.innerHTML = '';
    const hit = staffList.filter((s) => (showInactive.checked || s.active) && (!v || s.staff_name.includes(v) || s.staff_kana.includes(v) || (s.employee_id ?? '').includes(v)));
    if (!hit.length) list.append(el('div', { class: 'state', text: '該当なし（0件）' }));
    for (const s of hit) {
      const b = el('button', { type: 'button', class: 'item selectable' }, el('div', { class: 'grow' }, el('div', { class: 'name', text: `${s.employee_id ?? '---'} ${s.staff_name}` }), el('div', { class: 'sub', text: `${s.staff_kana}　主事業部：${s.main_department}${s.has_pin ? '' : '　⚠PIN未設定'}` })), el('span', { class: `tag ${s.active ? 'done' : 'overdue'}`, text: s.active ? '在籍' : '無効' }));
      b.addEventListener('click', () => openStaffForm(s));
      list.append(b);
    }
  };
  search.addEventListener('input', render); showInactive.addEventListener('change', render);
  const addBtn = el('button', { type: 'button', class: 'btn primary', text: '＋ スタッフを追加' }); addBtn.addEventListener('click', () => openStaffForm(null));
  content.append(el('div', { class: 'card' }, search, el('label', { class: 'check mt' }, showInactive, '無効（退職など）も表示'), addBtn), el('div', { class: 'card' }, el('p', { class: 'muted small', text: '従業員IDの正本は人事の「従業員リスト」です。氏名・かなの空白は自動で除去されます' }), list));
  render();
}
function openStaffForm(s: StaffA | null) {
  const body = el('div');
  const m = openModal(s ? `${s.staff_name} を編集` : 'スタッフを追加', body);
  const form = el('form', { novalidate: true });
  const name = el('input', { type: 'text', name: 'staff_name', value: s?.staff_name ?? '', required: true }) as HTMLInputElement;
  const kana = el('input', { type: 'text', name: 'staff_kana', value: s?.staff_kana ?? '' }) as HTMLInputElement;
  const emp = el('input', { type: 'text', name: 'employee_id', value: s?.employee_id ?? '', inputmode: 'numeric', placeholder: '空欄なら仮番号を採番' }) as HTMLInputElement;
  const email = el('input', { type: 'email', name: 'email', value: s?.email ?? '' }) as HTMLInputElement;
  const active = el('input', { type: 'checkbox', checked: s ? s.active : true }) as HTMLInputElement;
  const pin = el('input', { type: 'text', name: 'pin', inputmode: 'numeric', maxlength: '4', placeholder: s ? '変更するときだけ入力' : '4桁', autocomplete: 'off' }) as HTMLInputElement;
  const btn = el('button', { type: 'submit', class: 'btn primary', text: '保存' }) as HTMLButtonElement;
  form.append(field('氏名', name), field('よみがな', kana), field('従業員ID（3桁）', emp, '人事「従業員リスト」の個人コードに合わせる'), field('メール（退勤忘れリマインド用）', email), el('label', { class: 'check' }, active, '在籍（出勤できる）'), field(s ? '暗証番号を再設定' : '暗証番号（4桁）', pin), btn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { staff_name: name.value, staff_kana: kana.value, employee_id: emp.value || null, email: email.value || null, active: active.checked, pin: pin.value || null };
    try { const r = await busy(btn, '保存中…', () => (s ? put<{ message: string }>(`/api/admin/staff/${s.id}`, payload) : post<{ message: string }>('/api/admin/staff', payload))); m.close(); toast(r.message, 'success'); await loadMasters(); renderShell(); }
    catch (e) { toast(errorText(e), 'error'); if (isApiFailure(e) && e.info.field) form.querySelector<HTMLElement>(`[name="${e.info.field}"]`)?.focus(); }
  });
  body.append(form);
}

// ---------- 事業所 ----------
function renderLocations() {
  content.innerHTML = '';
  const list = el('div', { class: 'list' });
  for (const l of locations) {
    const flags = [l.check_alcohol ? 'アルコール' : '', l.gh_extras ? '手当・まかない' : '', l.gh_break_rule ? 'GH休憩ルール' : ''].filter(Boolean).join('・');
    const b = el('button', { type: 'button', class: 'item selectable' }, el('div', { class: 'grow' }, el('div', { class: 'name', text: `${l.location_name}` }), el('div', { class: 'sub', text: `${l.location_code}　${l.department}　${flags}` })), el('span', { class: `tag ${l.active ? 'done' : 'overdue'}`, text: l.active ? '有効' : '無効' }));
    b.addEventListener('click', () => openLocationForm(l));
    list.append(b);
  }
  const addBtn = el('button', { type: 'button', class: 'btn primary', text: '＋ 事業所を追加' }); addBtn.addEventListener('click', () => openLocationForm(null));
  content.append(el('div', { class: 'card' }, el('p', { class: 'muted small', text: 'GH系の判定は名前ではなくフラグで行います。「手当・まかない」「GH休憩ルール」を正しく設定してください' }), list, el('div', { class: 'mt' }, addBtn)));
}
function openLocationForm(l: Loc | null) {
  const body = el('div');
  const m = openModal(l ? `${l.location_name} を編集` : '事業所を追加', body);
  const form = el('form', { novalidate: true });
  const code = el('input', { type: 'text', name: 'location_code', value: l?.location_code ?? '', disabled: !!l, placeholder: '例：GH01（英数字）' }) as HTMLInputElement;
  const name = el('input', { type: 'text', name: 'location_name', value: l?.location_name ?? '' }) as HTMLInputElement;
  const dep = el('input', { type: 'text', name: 'department', value: l?.department ?? '', placeholder: '例：グループホーム' }) as HTMLInputElement;
  const sort = el('input', { type: 'number', name: 'sort_order', value: l?.sort_order ?? 0 }) as HTMLInputElement;
  const active = el('input', { type: 'checkbox', checked: l ? l.active : true }) as HTMLInputElement;
  const alc = el('input', { type: 'checkbox', checked: !!l?.check_alcohol }) as HTMLInputElement;
  const extras = el('input', { type: 'checkbox', checked: !!l?.gh_extras }) as HTMLInputElement;
  const rule = el('input', { type: 'checkbox', checked: !!l?.gh_break_rule }) as HTMLInputElement;
  const btn = el('button', { type: 'submit', class: 'btn primary', text: '保存' }) as HTMLButtonElement;
  form.append(field('事業所コード', code), field('事業所名', name), field('事業部（必須）', dep), field('並び順', sort),
    el('label', { class: 'check' }, active, '有効（端末で選べる）'), el('label', { class: 'check' }, alc, '出勤時にアルコールチェック数値を入力'),
    el('label', { class: 'check' }, extras, '退勤時に手当・まかないを入力（旧：名前に GH を含む事業所）'), el('label', { class: 'check' }, rule, 'GH休憩ルールで休憩を確認（旧：名前が GH で始まる事業所）'), btn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { location_code: code.value, location_name: name.value, department: dep.value, sort_order: Number(sort.value) || 0, active: active.checked, check_alcohol: alc.checked, gh_extras: extras.checked, gh_break_rule: rule.checked };
    try { const r = await busy(btn, '保存中…', () => (l ? put<{ message: string }>(`/api/admin/locations/${l.id}`, payload) : post<{ message: string }>('/api/admin/locations', payload))); m.close(); toast(r.message, 'success'); await loadMasters(); renderShell(); }
    catch (e) { toast(errorText(e), 'error'); }
  });
  body.append(form);
}

// ---------- 給与データ ----------
function renderPayroll() {
  content.innerHTML = '';
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  const ymIn = el('input', { type: 'month', value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }) as HTMLInputElement;
  const preview = el('div');
  const load = async () => {
    preview.innerHTML = ''; preview.append(loading());
    try {
      const r = await get<{ ym: string; staff: Array<{ employee_id: string; staff_name: string; work_days: number; record_count: number; work_minutes: number; night_minutes: number; travel_fee: number; allowance_amount: number; meal_fee: number; leave_days: number; incomplete: number }>; merged: Array<{ employee_id: string; staff_name: string; count: number }>; record_count: number; files: Array<{ filename: string; bytes: number }> }>(`/api/admin/payroll/preview?ym=${ymIn.value}`);
      preview.innerHTML = '';
      const incomplete = r.staff.filter((s) => s.incomplete > 0);
      if (incomplete.length) preview.append(el('div', { class: 'notice danger', text: `⚠ 未退勤（要確認）があります：${incomplete.map((s) => `${s.staff_name} ${s.incomplete}件`).join('、')}。給与確定前に勤怠タブで直してください` }));
      if (r.merged.length) preview.append(el('div', { class: 'notice warn', text: `同一人物として統合：${r.merged.map((x) => `${x.employee_id} ${x.staff_name}（${x.count}件）`).join('、')}（スタッフの重複登録の疑い）` }));
      preview.append(el('p', { class: 'muted small', text: `${r.ym}：スタッフ ${r.staff.length}名・記録 ${r.record_count}件` }));
      const table = el('table');
      table.append(el('thead', {}, el('tr', {}, ...['ID', '氏名', '出勤日', '回数', '実働', '深夜', '交通費', '手当', 'まかない', '有給', '未退勤'].map((h) => el('th', { text: h })))));
      const tb = el('tbody');
      for (const s of r.staff) tb.append(el('tr', {}, ...[s.employee_id, s.staff_name, s.work_days, s.record_count, minToHm(s.work_minutes), minToHm(s.night_minutes), s.travel_fee, s.allowance_amount, s.meal_fee, s.leave_days || '', s.incomplete || ''].map((v) => el('td', { text: String(v) }))));
      table.append(tb);
      preview.append(el('div', { class: 'table-wrap' }, table));
    } catch (e) { preview.innerHTML = ''; preview.append(errorState(e, load)); }
  };
  ymIn.addEventListener('change', load);
  const dl = (file: string, label: string) => el('a', { class: 'btn', href: '#', text: label, onclick: (ev: Event) => { ev.preventDefault(); location.href = `/api/admin/payroll/csv?ym=${ymIn.value}&file=${file}`; } });
  const sendBtn = el('button', { type: 'button', class: 'btn out', text: 'メールで送信（手動送信）' }) as HTMLButtonElement;
  sendBtn.addEventListener('click', async () => {
    if (!confirm(`${ymIn.value} 分の給与CSV 3種を「${settings['payroll_notify_emails'] || '（未設定）'}」へ送信します。よろしいですか？`)) return;
    try { const r = await busy(sendBtn, '送信中…', () => post<{ message: string }>('/api/admin/payroll/send', { ym: ymIn.value })); toast(r.message, 'success', 8000); } catch (e) { toast(errorText(e), 'error'); }
  });
  content.append(el('div', { class: 'card' }, field('対象月', ymIn), el('p', { class: 'muted small', text: `毎月${settings['payroll_send_day'] || 8}日 ${settings['payroll_send_hour'] || 7}時台に前月分を自動送信します（送信先は設定タブ）。列名・列順・形式は旧システムと同じです` }),
    el('div', { class: 'grid2' }, dl('summary', '① 給与集計'), dl('location', '② 事業所別勤務回数')), el('div', { class: 'mt' }, dl('detail', '③ 勤怠明細')), el('div', { class: 'mt' }, sendBtn)), el('div', { class: 'card' }, preview));
  load();
}

// ---------- 異常検知 ----------
function renderAnomalies() {
  content.innerHTML = '';
  const ymIn = el('input', { type: 'month', value: todayYmd().slice(0, 7) }) as HTMLInputElement;
  const list = el('div');
  const load = async () => {
    list.innerHTML = ''; list.append(loading());
    try {
      const r = await get<{ items: Array<{ code: string; label: string; staff_name: string; work_date: string; attendance_id: string; detail: string }> }>(`/api/admin/anomalies?ym=${ymIn.value}`);
      list.innerHTML = '';
      if (!r.items.length) { list.append(el('div', { class: 'state', text: '異常は見つかりませんでした（0件）' })); return; }
      const ul = el('div', { class: 'list' });
      for (const a of r.items) ul.append(el('div', { class: 'item' }, el('div', { class: 'grow' }, el('div', { class: 'name', text: `${fmtDateJa(a.work_date)} ${a.staff_name}` }), el('div', { class: 'sub', text: a.detail })), el('span', { class: 'tag overdue', text: a.label })));
      list.append(ul);
    } catch (e) { list.innerHTML = ''; list.append(errorState(e, load)); }
  };
  ymIn.addEventListener('change', load);
  content.append(el('div', { class: 'card' }, field('月', ymIn), el('p', { class: 'muted small', text: '実働30分未満／18時間超（GH休憩ルール対象は除外）／勤務間11時間未満／連続勤務6日超／8時間超で休憩なし／同一日複数／同時刻に複数事業所' })), el('div', { class: 'card' }, list));
  load();
}

// ---------- 設定 ----------
function renderSettings() {
  content.innerHTML = '';
  const form = el('form', { novalidate: true });
  const defs: Array<[string, string, string]> = [
    ['company_name', '会社名（画面表示）', ''], ['travel_fee_per_km', '交通費単価（円/km）', ''], ['meal_unit_price', 'まかない単価（円/食）', ''],
    ['payroll_notify_emails', '給与CSVの送信先メール（カンマ区切り）', '給与担当・社労士など'], ['admin_notify_emails', '管理者通知メール（失敗通知など）', ''],
    ['admin_emails', '管理画面にログインできる Google アカウント（カンマ区切り）', 'サーバーの ADMIN_EMAILS と合算'],
    ['payroll_send_day', '給与CSV自動送信の日', '既定 8'], ['payroll_send_hour', '給与CSV自動送信の時（0-23）', '既定 7'],
    ['checkout_reminder_hour', '退勤忘れリマインドの時', '既定 9'], ['backup_hour', 'バックアップの時', '既定 3'], ['backup_keep_days', 'バックアップ保持日数', '既定 30'],
    ['report_blocked_emails', '出勤報告を絶対に送らない宛先', ''], ['app_base_url', '本番URL（メールのリンク用）', '例：https://timecard.daizu.info'],
  ];
  const inputs: Record<string, HTMLInputElement> = {};
  for (const [k, label, hint] of defs) { inputs[k] = el('input', { type: 'text', name: k, value: settings[k] ?? '' }) as HTMLInputElement; form.append(field(label, inputs[k]!, hint)); }
  const btn = el('button', { type: 'submit', class: 'btn primary', text: '設定を保存' }) as HTMLButtonElement;
  form.append(btn);
  form.addEventListener('submit', async (ev) => { ev.preventDefault(); try { await busy(btn, '保存中…', () => put('/api/admin/settings', Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])))); toast('設定を保存しました', 'success'); await loadMasters(); } catch (e) { toast(errorText(e), 'error'); } });
  // 起動PIN
  const gate = el('form', { novalidate: true });
  const pin = el('input', { type: 'text', inputmode: 'numeric', maxlength: '4', placeholder: '4桁', autocomplete: 'off' }) as HTMLInputElement;
  const gbtn = el('button', { type: 'submit', class: 'btn out', text: '起動PINを設定する（全端末で再入力が必要）' }) as HTMLButtonElement;
  gate.append(field('起動PIN（4桁）', pin, '打刻画面・マイページを開くときに各端末で1回入力。5回間違えるとその端末だけ5分ロック'), gbtn);
  gate.addEventListener('submit', async (ev) => { ev.preventDefault(); if (!confirm('起動PINを変更すると、すべての端末で次回開いたときに新しいPINの入力が必要になります。よろしいですか？')) return; try { const r = await busy(gbtn, '保存中…', () => put<{ message: string }>('/api/admin/settings/gate-pin', { pin: pin.value })); toast(r.message, 'success', 8000); pin.value = ''; } catch (e) { toast(errorText(e), 'error'); } });
  get<{ gate_pin_set: boolean; mail_configured: boolean }>('/api/admin/settings').then((r) => {
    content.prepend(el('div', { class: `notice ${r.gate_pin_set ? 'ok' : 'danger'}`, text: r.gate_pin_set ? '起動PIN：設定済み' : '⚠ 起動PINが未設定です。設定するまで打刻端末は使えません' }), el('div', { class: `notice ${r.mail_configured ? 'ok' : 'warn'}`, text: r.mail_configured ? 'メール送信：設定済み（SMTP）' : '⚠ メール送信（SMTP）が未設定です。給与CSVはサーバーの outbox フォルダに書き出されるだけでメールは届きません' }));
  }).catch(() => {});
  content.append(el('div', { class: 'card' }, el('h2', { text: '起動PIN' }), gate), el('div', { class: 'card' }, el('h2', { text: '各種設定' }), form));
}

// ---------- 定期処理・ログ ----------
function renderJobs() {
  content.innerHTML = '';
  const box = el('div');
  const load = async () => {
    box.innerHTML = ''; box.append(loading());
    try {
      const [j, a, ml] = await Promise.all([get<{ jobs: Array<{ name: string; description: string; last: Array<{ period_key: string; started_at: string; finished_at: string | null; ok: boolean | null; detail: string | null }> }> }>('/api/admin/jobs'), get<{ items: Array<{ ts: string; actor_label: string; action: string; target: string | null }> }>('/api/admin/audit?limit=100'), get<{ items: Array<{ ts: string; kind: string; to_addrs: string; subject: string; ok: boolean; error: string | null }> }>('/api/admin/mail-log')]);
      box.innerHTML = '';
      for (const job of j.jobs) {
        const runBtn = el('button', { type: 'button', class: 'btn', text: '今すぐ実行', style: 'width:auto' }) as HTMLButtonElement;
        runBtn.addEventListener('click', async () => { try { const r = await busy(runBtn, '実行中…', () => post<{ result: { ok: boolean; detail: string } }>(`/api/admin/jobs/${job.name}/run`, {})); toast(`${job.name}: ${r.result.detail}`, r.result.ok ? 'success' : 'error', 8000); load(); } catch (e) { toast(errorText(e), 'error'); } });
        const last = job.last[0];
        box.append(el('div', { class: 'card' }, el('div', { class: 'sheet-head' }, el('h3', { text: ({ overdue: '退勤忘れ判定', payroll: '給与CSV送信', backup: 'バックアップ', sessions: 'セッション掃除' } as Record<string, string>)[job.name] ?? job.name }), job.name === 'payroll' ? null : runBtn), el('p', { class: 'small', text: job.description }),
          el('div', { class: 'muted small', text: last ? `最終：${fmtTs(last.started_at)} ${last.ok === null ? '実行中' : last.ok ? '成功' : '失敗'} ${last.detail ?? ''}` : 'まだ実行されていません' })));
      }
      const mt = el('table'); mt.append(el('thead', {}, el('tr', {}, ...['日時', '種類', '宛先', '件名', '結果'].map((h) => el('th', { text: h })))), el('tbody', {}, ...ml.items.map((m) => el('tr', {}, ...[fmtTs(m.ts), m.kind, m.to_addrs, m.subject, m.ok ? 'OK' : `失敗 ${m.error ?? ''}`].map((v) => el('td', { text: v }))))));
      box.append(el('div', { class: 'card' }, el('h3', { text: 'メール送信ログ' }), el('div', { class: 'table-wrap' }, mt)));
      const at = el('table'); at.append(el('thead', {}, el('tr', {}, ...['日時', '誰が', '操作', '対象'].map((h) => el('th', { text: h })))), el('tbody', {}, ...a.items.map((x) => el('tr', {}, ...[fmtTs(x.ts), x.actor_label, x.action, (x.target ?? '').slice(0, 12)].map((v) => el('td', { text: v }))))));
      box.append(el('div', { class: 'card' }, el('h3', { text: '監査ログ（最新100件）' }), el('div', { class: 'table-wrap' }, at)));
    } catch (e) { box.innerHTML = ''; box.append(errorState(e, load)); }
  };
  content.append(box);
  load();
}


main().catch((e) => { app.innerHTML = ''; app.append(el('div', { class: 'card' }, el('div', { class: 'state error' }, el('div', { text: errorText(e) }), el('button', { type: 'button', class: 'btn', text: 'もう一度読み込む', onclick: () => location.reload() })))); });
