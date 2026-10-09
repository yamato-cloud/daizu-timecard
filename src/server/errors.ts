/**
 * エラーは HTTP ステータスで返し、サーバーの拒否理由（message）をそのまま利用者に見せる。
 * 「失敗しました」だけは禁止（10章）。
 */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
export const badRequest = (msg: string, code = 'BAD_REQUEST', field?: string, extra?: Record<string, unknown>) => new AppError(400, code, msg, field, extra);
export const unauthorized = (msg = 'ログインが必要です', code = 'UNAUTHORIZED') => new AppError(401, code, msg);
export const forbidden = (msg = 'この操作は許可されていません', code = 'FORBIDDEN', extra?: Record<string, unknown>) => new AppError(403, code, msg, undefined, extra);
export const notFound = (msg = '見つかりません', code = 'NOT_FOUND') => new AppError(404, code, msg);
export const conflict = (msg: string, code = 'CONFLICT', extra?: Record<string, unknown>) => new AppError(409, code, msg, undefined, extra);
export const tooMany = (msg: string, code = 'TOO_MANY', extra?: Record<string, unknown>) => new AppError(429, code, msg, undefined, extra);
