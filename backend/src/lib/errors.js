export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new AppError(400, 'bad_request', msg, details);
export const forbidden = (msg = 'Aapke paas is kaam ki permission nahi hai') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Nahi mila') => new AppError(404, 'not_found', msg);
export const conflict = (msg, details) => new AppError(409, 'conflict', msg, details);
