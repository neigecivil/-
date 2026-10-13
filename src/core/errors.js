'use strict';

/* 统一的业务异常：带上 HTTP 状态码，接口层照着回就行。 */

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

const badRequest = (m) => new AppError(400, m);
const unauthorized = (m) => new AppError(401, m);
const forbidden = (m) => new AppError(403, m);
const notFound = (m) => new AppError(404, m);
const conflict = (m) => new AppError(409, m);
const tooLarge = (m) => new AppError(413, m);

export { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooLarge };
