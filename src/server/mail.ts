/**
 * メール送信。SMTP（環境変数）。未設定なら outbox/ に .eml を書き出す（開発・検証用）。
 * 送信結果は mail_log に残す（二重送信の切り分け用）。
 */
import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { q } from './db.js';
import { getSetting, parseEmails } from './settings.js';

export interface MailInput { kind: string; to: string[]; subject: string; text: string; attachments?: Array<{ filename: string; content: string | Buffer; contentType?: string }> }

let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter | null {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined });
  }
  return transporter;
}

export const mailConfigured = (): boolean => !!config.smtp.host;

export async function sendMail(m: MailInput): Promise<void> {
  const to = m.to.map((s) => s.trim()).filter(Boolean);
  if (!to.length) throw new Error('宛先がありません');
  try {
    const t = getTransporter();
    if (t) {
      await t.sendMail({ from: config.smtp.from, to: to.join(','), subject: m.subject, text: m.text, attachments: m.attachments });
    } else {
      // 開発用：ファイルに書き出す
      await mkdir(config.outboxDir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${m.kind}.eml`;
      const body = [`To: ${to.join(', ')}`, `Subject: ${m.subject}`, '', m.text, '', ...(m.attachments ?? []).map((a) => `--- 添付: ${a.filename} (${Buffer.byteLength(a.content)} bytes) ---`)].join('\n');
      await writeFile(path.join(config.outboxDir, name), body, 'utf8');
      for (const a of m.attachments ?? []) await writeFile(path.join(config.outboxDir, `${name}.${a.filename}`), a.content);
    }
    await q('INSERT INTO mail_log (kind, to_addrs, subject, ok) VALUES ($1,$2,$3,true)', [m.kind, to.join(','), m.subject]);
  } catch (e) {
    await q('INSERT INTO mail_log (kind, to_addrs, subject, ok, error) VALUES ($1,$2,$3,false,$4)', [m.kind, to.join(','), m.subject, String((e as Error).message ?? e)]).catch(() => {});
    throw e;
  }
}

/** 管理者への通知（失敗通知など）。宛先未設定なら何もしない（ログだけ） */
export async function notifyAdmins(subject: string, text: string): Promise<boolean> {
  const to = parseEmails(await getSetting('admin_notify_emails', ''));
  if (!to.length) { console.warn('[notifyAdmins] admin_notify_emails 未設定:', subject); return false; }
  await sendMail({ kind: 'admin_notify', to, subject, text });
  return true;
}
