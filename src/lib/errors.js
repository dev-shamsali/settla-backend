export class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (m = 'Bad request', code = 'BAD_REQUEST', d) => new AppError(code, m, 400, d);
export const unauthorized = (m = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(code, m, 401);
export const forbidden = (m = 'Permission denied', code = 'FORBIDDEN') => new AppError(code, m, 403);
export const notFound = (m = 'Not found', code = 'NOT_FOUND') => new AppError(code, m, 404);
export const conflict = (m = 'Conflict', code = 'CONFLICT') => new AppError(code, m, 409);
export const tooMany = (m = 'Too many requests') => new AppError('RATE_LIMITED', m, 429);
