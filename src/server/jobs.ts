/**
 * 定期処理。原則：冪等（job_runs の期間キーで二重実行を防ぐ）・引数を取らない・失敗したら管理者に通知。
 * 毎分 tick し、各ジョブが「今が実行時期か」を JST で判定する。サーバーが止まっていた時間帯の分は、復帰後に遅れて1回だけ実行される。
 */
import cron from 'node-cron';
import { q, one } from './db.js';
import { getNumberSetting } from './settings.js';
import { notifyAdmins } from './mail.js';
import { audit, SYSTEM_ACTOR, type Actor } from './audit.js';
import { markOverdue } from './services/attendance.js';
import { sendPayroll } from './services/payroll.js';
import { runBackup } from './services/backup.js';
import { purgeExpiredSessions } from './auth.js';
import { msToJst, prevYm } from '../calc/index.js';

export interface JobDef {
  name: string;
  description: string;
  /** 今が実行時期なら期間キーを返す（同じキーでは二度と実行しない） */
  due: (now: { date: string; time: string; ms: number }) => Promise<string | null>;
  run: () => Promise<string>;
  /** 失敗時に再試行するまでの間隔（分） */
  retryMinutes: number;
}

const RETRY_DEFAULT = 60;

export const JOBS: JobDef[] = [
  {
    name: 'overdue', description: '出勤から24時間超の勤務中を「退勤忘れ」にする（毎時）', retryMinutes: 10,
    due: async (n) => `${n.date}T${n.time.slice(0, 2)}`,
    run: async () => `${await markOverdue()}件を OVERDUE にしました`,
  },
  {
    name: 'payroll', description: '前月分の給与CSV 3種をメール送信（毎月8日 7時台）', retryMinutes: RETRY_DEFAULT,
    due: async (n) => {
      // 送信日の送信時以降に1回。サーバー停止などで送れなかった場合は送信日から2日以内なら遅れて送る。それ以降は手動送信
      const day = await getNumberSetting('payroll_send_day', 8);
      const hour = await getNumberSetting('payroll_send_hour', 7);
      const d = Number(n.date.slice(8, 10));
      const h = Number(n.time.slice(0, 2));
      if (d < day || d > day + 2 || (d === day && h < hour)) return null;
      return prevYm(n.date.slice(0, 7));
    },
    run: async () => {
      const ym = prevYm(msToJst(Date.now()).date.slice(0, 7));
      const r = await sendPayroll(ym, '自動送信');
      return `${ym} 分を ${r.sent_to.join(',')} へ送信（${r.staff_count}名・${r.record_count}件）`;
    },
  },
  {
    name: 'backup', description: 'DBバックアップとCSV書き出し（毎日3時台、30日保持）', retryMinutes: RETRY_DEFAULT,
    due: async (n) => (Number(n.time.slice(0, 2)) >= (await getNumberSetting('backup_hour', 3)) ? n.date : null),
    run: async () => runBackup(),
  },
  {
    name: 'sessions', description: '期限切れセッションの掃除（毎時）', retryMinutes: 10,
    due: async (n) => `${n.date}T${n.time.slice(0, 2)}`,
    run: async () => { await purgeExpiredSessions(); return 'ok'; },
  },
];

let running = false;
export async function tick(nowMs = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const j = msToJst(nowMs);
    for (const job of JOBS) {
      let key: string | null = null;
      try { key = await job.due({ ...j, ms: nowMs }); } catch (e) { console.error(`[jobs] due() failed: ${job.name}`, e); continue; }
      if (!key) continue;
      const prev = await one<{ ok: boolean | null; started_at: Date }>('SELECT ok, started_at FROM job_runs WHERE job_name = $1 AND period_key = $2', [job.name, key]);
      if (prev?.ok) continue;
      if (prev && nowMs - prev.started_at.getTime() < job.retryMinutes * 60e3) continue;
      await execute(job, key, SYSTEM_ACTOR);
    }
  } finally {
    running = false;
  }
}

async function execute(job: JobDef, key: string, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  await q('INSERT INTO job_runs (job_name, period_key, started_at, finished_at, ok, detail) VALUES ($1,$2,now(),NULL,NULL,NULL) ON CONFLICT (job_name, period_key) DO UPDATE SET started_at = now(), finished_at = NULL, ok = NULL, detail = NULL', [job.name, key]);
  try {
    const detail = await job.run();
    await q('UPDATE job_runs SET finished_at = now(), ok = true, detail = $3 WHERE job_name = $1 AND period_key = $2', [job.name, key, detail]);
    await audit(actor, `job.${job.name}`, key, null, { ok: true, detail });
    return { ok: true, detail };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    await q('UPDATE job_runs SET finished_at = now(), ok = false, detail = $3 WHERE job_name = $1 AND period_key = $2', [job.name, key, msg]);
    await audit(actor, `job.${job.name}`, key, null, { ok: false, error: msg });
    console.error(`[jobs] ${job.name} failed:`, e);
    try {
      await notifyAdmins(`⚠️ タイムカード定期処理の失敗：${job.name}（${key}）`,
        `定期処理「${job.description}」が失敗しました。\n\n【エラー】\n${msg}\n\n${job.retryMinutes}分後に自動で再試行します。続く場合は管理画面 → 定期処理 から手動実行、またはサーバーのログを確認してください。`);
    } catch (e2) { console.error('[jobs] notifyAdmins failed', e2); }
    return { ok: false, detail: msg };
  }
}

/** 管理画面からの手動実行（期間キーは「手動:日時」で別扱い。給与は手動送信 API を使うこと） */
export async function runJobNow(name: string, actor: Actor): Promise<{ ok: boolean; detail: string }> {
  const job = JOBS.find((j) => j.name === name);
  if (!job) throw new Error(`定期処理「${name}」はありません`);
  if (name === 'payroll') throw new Error('給与送信は「給与データ」画面の手動送信を使ってください');
  const key = `manual:${new Date().toISOString()}`;
  return execute(job, key, actor);
}

export async function jobStatus(): Promise<Array<{ name: string; description: string; last: unknown }>> {
  const out = [];
  for (const j of JOBS) {
    const last = await q('SELECT period_key, started_at, finished_at, ok, detail FROM job_runs WHERE job_name = $1 ORDER BY started_at DESC LIMIT 5', [j.name]);
    out.push({ name: j.name, description: j.description, last });
  }
  return out;
}

/**
 * 初回起動（job_runs に給与送信の記録が1件も無い）では、導入直後に前月分の給与メールを自動送信しない。
 * 並行運用中は旧システムも送るため二重になる（引継書 §12.2）。初回は管理画面から手動送信する。
 */
export async function guardFirstBoot(nowMs = Date.now()): Promise<void> {
  const any = await one("SELECT 1 FROM job_runs WHERE job_name = 'payroll'");
  if (any) return;
  const ym = prevYm(msToJst(nowMs).date.slice(0, 7));
  await q('INSERT INTO job_runs (job_name, period_key, started_at, finished_at, ok, detail) VALUES ($1,$2,now(),now(),true,$3) ON CONFLICT DO NOTHING', ['payroll', ym, '初回起動のため自動送信をスキップ（必要なら管理画面から手動送信）']);
}

export function startScheduler(): void {
  cron.schedule('* * * * *', () => { tick().catch((e) => console.error('[jobs] tick failed', e)); });
  guardFirstBoot().then(() => tick()).catch((e) => console.error('[jobs] initial tick failed', e));
}
