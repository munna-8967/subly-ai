/**
 * An error whose message is safe to show to the user.
 * Anything that is NOT an AppError is treated as a bug: it is logged on the
 * server and the client only sees a generic message.
 */
export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
