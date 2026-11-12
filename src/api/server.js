'use strict';

const { createServer } = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { verifyPassword } = require('../security/password-hasher.js');
const { createActionLogger } = require('../observability/action-logger.js');
const { RegistrationError, registerUser } = require('../application/registration-service.js');
const {
  StatisticsQueryError,
  calculateStatistics,
  resolveStatisticsPeriod,
} = require('../application/statistics-service.js');
const { getDateInKyiv } = require('../time/kyiv-date.js');

const REGISTER_PATH = '/api/auth/register';
const LOGIN_PATH = '/api/auth/login';
const LOGOUT_PATH = '/api/auth/logout';
const SESSION_COOKIE = 'pt_session';
const ALLOWED_REGISTRATION_FIELDS = new Set(['email', 'password']);
const ALLOWED_BOOK_FIELDS = new Set(['title', 'author', 'totalPages']);
const ALLOWED_BOOK_PATCH_FIELDS = new Set(['title', 'author', 'totalPages', 'rating']);
const ALLOWED_READING_RECORD_FIELDS = new Set(['startPage', 'endPage']);

class ApiProblem extends Error {
  constructor(status, code, title, detail, errors) {
    super(detail);
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.errors = errors;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiProblem(400, 'INVALID_JSON', 'Bad Request', 'Некоректний JSON');
  }
}

function validateRegistrationShape(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані');
  }

  const unknownFields = Object.keys(body).filter((field) => !ALLOWED_REGISTRATION_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new ApiProblem(400, 'INVALID_PARAMETER', 'Bad Request', 'Невідоме поле запиту', unknownFields.map((field) => ({
      pointer: `/${field}`,
      code: 'unknown_field',
      message: 'Невідоме поле запиту',
    })));
  }
}

function validateCredentials(email, password) {
  const errors = [];
  if (typeof email !== 'string' || email.trim().length === 0) {
    errors.push({ pointer: '/email', code: 'required', message: 'заповніть дані' });
  }
  if (typeof password !== 'string' || password.trim().length === 0) {
    errors.push({ pointer: '/password', code: 'required', message: 'заповніть дані' });
  }
  if (errors.length > 0) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані', errors);
  }
}

function validateBookShape(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані');
  }

  const unknownFields = Object.keys(body).filter((field) => !ALLOWED_BOOK_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new ApiProblem(
      400,
      'INVALID_PARAMETER',
      'Bad Request',
      'Невідоме поле запиту',
      unknownFields.map((field) => ({
        pointer: `/${field}`,
        code: 'unknown_field',
        message: 'Невідоме поле запиту',
      })),
    );
  }

  const errors = [];
  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    errors.push({ pointer: '/title', code: 'required', message: 'заповніть дані' });
  }
  if (typeof body.author !== 'string' || body.author.trim().length === 0) {
    errors.push({ pointer: '/author', code: 'required', message: 'заповніть дані' });
  }
  if (!Number.isInteger(body.totalPages) || body.totalPages < 1) {
    errors.push({ pointer: '/totalPages', code: 'minimum', message: 'заповніть дані' });
  }
  if (errors.length > 0) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані', errors);
  }
}

function validateBookPatchShape(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані');
  }

  const fields = Object.keys(body);
  if (fields.length === 0) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані');
  }

  const unknownFields = fields.filter((field) => !ALLOWED_BOOK_PATCH_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new ApiProblem(
      400,
      'INVALID_PARAMETER',
      'Bad Request',
      'Невідоме поле запиту',
      unknownFields.map((field) => ({
        pointer: `/${field}`,
        code: 'unknown_field',
        message: 'Невідоме поле запиту',
      })),
    );
  }

  const errors = [];
  if ('title' in body && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
    errors.push({ pointer: '/title', code: 'required', message: 'заповніть дані' });
  }
  if ('author' in body && (typeof body.author !== 'string' || body.author.trim().length === 0)) {
    errors.push({ pointer: '/author', code: 'required', message: 'заповніть дані' });
  }
  if ('totalPages' in body && (!Number.isInteger(body.totalPages) || body.totalPages < 1)) {
    errors.push({ pointer: '/totalPages', code: 'minimum', message: 'заповніть дані' });
  }
  if ('rating' in body && (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5)) {
    errors.push({ pointer: '/rating', code: 'range', message: 'заповніть дані' });
  }
  if (errors.length > 0) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані', errors);
  }
}

function validateReadingRecordShape(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані');
  }

  const unknownFields = Object.keys(body).filter(
    (field) => !ALLOWED_READING_RECORD_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    throw new ApiProblem(
      400,
      'INVALID_PARAMETER',
      'Bad Request',
      'Невідоме поле запиту',
      unknownFields.map((field) => ({
        pointer: `/${field}`,
        code: 'unknown_field',
        message: 'Невідоме поле запиту',
      })),
    );
  }

  const errors = [...ALLOWED_READING_RECORD_FIELDS]
    .filter((field) => !Object.hasOwn(body, field))
    .map((field) => ({ pointer: `/${field}`, code: 'required', message: 'заповніть дані' }));
  if (errors.length > 0) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані', errors);
  }

  return body;
}

function validateReadingRecordPatchShape(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані');
  }
  const fields = Object.keys(body);
  if (fields.length === 0) {
    throw new ApiProblem(422, 'VALIDATION_ERROR', 'Unprocessable Content', 'заповніть дані');
  }
  const unknownFields = fields.filter((field) => !ALLOWED_READING_RECORD_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new ApiProblem(
      400,
      'INVALID_PARAMETER',
      'Bad Request',
      'Невідоме поле запиту',
      unknownFields.map((field) => ({
        pointer: `/${field}`,
        code: 'unknown_field',
        message: 'Невідоме поле запиту',
      })),
    );
  }
}

function validateReadingRecordRange(payload, book) {
  const { startPage, endPage } = payload;
  if (
    !Number.isInteger(startPage) ||
    !Number.isInteger(endPage) ||
    startPage < 1 ||
    endPage < 1 ||
    startPage > book.totalPages ||
    endPage > book.totalPages
  ) {
    throw new ApiProblem(
      422,
      'VALIDATION_ERROR',
      'Unprocessable Content',
      'Будь ласка, змініть сторінку',
    );
  }
  if (endPage < startPage) {
    throw new ApiProblem(
      422,
      'VALIDATION_ERROR',
      'Unprocessable Content',
      'Кінцева сторінка, менша за початкову',
    );
  }
}

function validateReadingRecordSequence(candidate, records) {
  if (records.some(
    (record) => candidate.startPage <= record.endPage && candidate.endPage >= record.startPage,
  )) {
    throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Ці сторінки вже прочитані');
  }

  const ordered = [...records, candidate].sort(
    (left, right) => left.startPage - right.startPage || left.endPage - right.endPage,
  );
  if (ordered[0]?.startPage !== 1) {
    throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Відсутні сторінки');
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].startPage !== ordered[index - 1].endPage + 1) {
      throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Відсутні сторінки');
    }
  }
}

function publicBook(book) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    totalPages: book.totalPages,
    status: book.status,
    rating: book.rating,
  };
}

function publicReadingRecord(record) {
  return {
    id: record.id,
    bookId: record.bookId,
    startPage: record.startPage,
    endPage: record.endPage,
    pagesRead: record.pagesRead,
    date: record.date,
  };
}

function toProblem(error, instance) {
  if (error instanceof ApiProblem) {
    return {
      type: `urn:pagetracker:problem:${error.code}`,
      title: error.title,
      status: error.status,
      code: error.code,
      detail: error.detail,
      instance,
      ...(error.errors ? { errors: error.errors } : {}),
    };
  }

  if (error instanceof RegistrationError) {
    const title = error.status === 409 ? 'Неправильні дані' : 'Unprocessable Content';
    return {
      type: `urn:pagetracker:problem:${error.code}`,
      title,
      status: error.status,
      code: error.code,
      detail: error.detail,
      instance,
      ...(error.errors ? { errors: error.errors } : {}),
    };
  }

  return {
    type: 'urn:pagetracker:problem:INTERNAL_ERROR',
    title: 'Internal Server Error',
    status: 500,
    code: 'INTERNAL_ERROR',
    detail: 'Помилка',
    instance,
  };
}

function sendJson(response, status, body, contentType = 'application/json; charset=utf-8') {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

function sendNoContent(response, headers = {}) {
  response.writeHead(204, headers);
  response.end();
}

function readSessionToken(request) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return null;
  }
  for (const item of cookieHeader.split(';')) {
    const [name, ...valueParts] = item.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = valueParts.join('=');
      return value || null;
    }
  }
  return null;
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function authenticateRequest(request, store) {
  const token = readSessionToken(request);
  if (!token) {
    throw new ApiProblem(401, 'AUTH_REQUIRED', 'Unauthorized', 'Потрібно увійти');
  }

  const tokenHash = hashSessionToken(token);
  const session = await store.sessions.findByTokenHash(tokenHash);
  if (!session) {
    throw new ApiProblem(401, 'AUTH_REQUIRED', 'Unauthorized', 'Потрібно увійти');
  }

  const user = await store.users.findById(session.userId);
  if (!user) {
    await store.sessions.deleteByTokenHash(tokenHash);
    throw new ApiProblem(401, 'AUTH_REQUIRED', 'Unauthorized', 'Потрібно увійти');
  }

  return user;
}

function publicUser(user) {
  return { id: user.id, email: user.email };
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
}

function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function createApiServer({ store, logger = createActionLogger() } = {}) {
  if (!store?.users || typeof store.users.findByEmail !== 'function' || typeof store.users.create !== 'function') {
    throw new TypeError('Store must provide user lookup and creation');
  }
  if (!logger || typeof logger.logAction !== 'function') {
    throw new TypeError('Logger must provide logAction');
  }

  return createServer((request, response) => {
    void handleRequest(request, response, { store, logger }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }

      sendJson(
        response,
        500,
        toProblem(error, new URL(request.url, 'http://localhost').pathname),
        'application/problem+json; charset=utf-8',
      );
    });
  });
}

async function handleRequest(request, response, { store, logger }) {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname;
  const readingRecordsPath = pathname.match(/^\/api\/books\/([^/]+)\/reading-records$/);
  const readingRecordPath = pathname.match(/^\/api\/reading-records\/([^/]+)$/);
  let status = 500;
  let outcome = 'failure';
  let body;
  let contentType = 'application/json; charset=utf-8';
  let responseHeaders = {};
  let noContent = false;
  let actorId = null;
  let action = 'http.request';

  try {
    if (pathname === REGISTER_PATH && request.method === 'POST') {
      action = 'auth.register';
      const payload = await readJsonBody(request);
      validateRegistrationShape(payload);
      const user = await registerUser({
        store,
        email: payload.email,
        password: payload.password,
      });
      status = 201;
      outcome = 'success';
      body = { data: { user } };
    } else if (pathname === LOGIN_PATH && request.method === 'POST') {
      action = 'auth.login';
      const payload = await readJsonBody(request);
      validateRegistrationShape(payload);
      validateCredentials(payload.email, payload.password);
      const user = await store.users.findByEmail(payload.email);
      const passwordMatches =
        user && (await verifyPassword(payload.password, user.passwordHash));
      if (!passwordMatches) {
        throw new ApiProblem(401, 'INVALID_CREDENTIALS', 'Неправильні дані', 'Неправильні дані');
      }

      const token = randomBytes(32).toString('base64url');
      await store.sessions.create({
        userId: user.id,
        tokenHash: hashSessionToken(token),
      });
      actorId = user.id;
      status = 200;
      outcome = 'success';
      responseHeaders['set-cookie'] = sessionCookie(token);
      body = { data: { user: publicUser(user) } };
    } else if (pathname === LOGOUT_PATH && request.method === 'POST') {
      action = 'auth.logout';
      const token = readSessionToken(request);
      if (token) {
        const tokenHash = hashSessionToken(token);
        const session = await store.sessions.findByTokenHash(tokenHash);
        if (session) {
          actorId = session.userId;
        }
        await store.sessions.deleteByTokenHash(tokenHash);
      }
      status = 204;
      outcome = 'success';
      noContent = true;
      responseHeaders['set-cookie'] = clearedSessionCookie();
    } else if (pathname === '/api/statistics' && request.method === 'GET') {
      action = 'statistics.read';
      const user = await authenticateRequest(request, store);
      actorId = user.id;
      const today = getDateInKyiv();
      let period;
      try {
        period = resolveStatisticsPeriod({
          period: url.searchParams.get('period'),
          date: url.searchParams.get('date'),
          today,
        });
      } catch (error) {
        if (!(error instanceof StatisticsQueryError)) {
          throw error;
        }
        throw new ApiProblem(400, 'INVALID_PARAMETER', 'Некоректний параметр', error.message);
      }
      const records = await store.readingRecords.listByUser(user.id);
      status = 200;
      outcome = 'success';
      body = { data: calculateStatistics(records, period, today) };
    } else if (readingRecordsPath && request.method === 'GET') {
      action = 'reading-records.list';
      const user = await authenticateRequest(request, store);
      actorId = user.id;
      const book = await store.books.findByIdForUser(readingRecordsPath[1], user.id);
      if (!book) {
        throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
      }
      const records = (await store.readingRecords.listByUser(user.id))
        .filter((record) => record.bookId === book.id)
        .sort(
          (left, right) =>
            left.date.localeCompare(right.date) ||
            left.startPage - right.startPage ||
            left.id.localeCompare(right.id),
        );
      status = 200;
      outcome = 'success';
      body = { data: records.map(publicReadingRecord) };
    } else if (readingRecordsPath && request.method === 'POST') {
      action = 'reading-records.create';
      const user = await authenticateRequest(request, store);
      actorId = user.id;
      const payload = await readJsonBody(request);
      validateReadingRecordShape(payload);
      const record = await store.transaction(async (repositories) => {
        const book = await repositories.books.findByIdForUserForUpdate(
          readingRecordsPath[1],
          user.id,
        );
        if (!book) {
          throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
        }
        if (book.status === 'прочитано') {
          throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Книга вже прочитана');
        }
        validateReadingRecordRange(payload, book);

        const existingRecords = (await repositories.readingRecords.listByUser(user.id))
          .filter((item) => item.bookId === book.id);
        if (existingRecords.some(
          (item) => payload.startPage <= item.endPage && payload.endPage >= item.startPage,
        )) {
          throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Ці сторінки вже прочитані');
        }

        const expectedStartPage = existingRecords.length === 0
          ? 1
          : Math.max(...existingRecords.map((item) => item.endPage)) + 1;
        if (payload.startPage !== expectedStartPage) {
          throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Відсутні сторінки');
        }

        const createdRecord = await repositories.readingRecords.create({
          bookId: book.id,
          startPage: payload.startPage,
          endPage: payload.endPage,
          date: getDateInKyiv(),
        });
        const nextStatus = payload.endPage === book.totalPages ? 'прочитано' : 'читається';
        const updatedBook = await repositories.books.updateStatusForUser(
          book.id,
          user.id,
          nextStatus,
        );
        if (!updatedBook) {
          throw new Error('Book disappeared during reading-record creation');
        }
        return createdRecord;
      });
      status = 201;
      outcome = 'success';
      body = { data: publicReadingRecord(record) };
    } else if (readingRecordPath && ['PATCH', 'DELETE'].includes(request.method)) {
      action = request.method === 'PATCH' ? 'reading-records.update' : 'reading-records.delete';
      const user = await authenticateRequest(request, store);
      actorId = user.id;

      if (request.method === 'PATCH') {
        const changes = await readJsonBody(request);
        validateReadingRecordPatchShape(changes);
        const record = await store.transaction(async (repositories) => {
          const current = await repositories.readingRecords.findByIdForUserForUpdate(
            readingRecordPath[1],
            user.id,
          );
          if (!current) {
            throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
          }
          const book = await repositories.books.findByIdForUserForUpdate(current.bookId, user.id);
          if (!book) {
            throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
          }
          if (book.status !== 'читається') {
            throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Запис не можна редагувати');
          }

          const candidate = { ...current, ...changes };
          validateReadingRecordRange(candidate, book);
          const otherRecords = (await repositories.readingRecords.listByUser(user.id))
            .filter((item) => item.bookId === book.id && item.id !== current.id);
          validateReadingRecordSequence(candidate, otherRecords);

          const updatedRecord = await repositories.readingRecords.updateForUser(
            current.id,
            user.id,
            { startPage: candidate.startPage, endPage: candidate.endPage },
          );
          if (!updatedRecord) {
            throw new Error('Reading record disappeared during update');
          }
          const nextStatus = candidate.endPage === book.totalPages ? 'прочитано' : 'читається';
          const updatedBook = await repositories.books.updateStatusForUser(
            book.id,
            user.id,
            nextStatus,
          );
          if (!updatedBook) {
            throw new Error('Book disappeared during reading-record update');
          }
          return updatedRecord;
        });
        status = 200;
        outcome = 'success';
        body = { data: publicReadingRecord(record) };
      } else {
        await store.transaction(async (repositories) => {
          const current = await repositories.readingRecords.findByIdForUserForUpdate(
            readingRecordPath[1],
            user.id,
          );
          if (!current) {
            throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
          }
          const book = await repositories.books.findByIdForUserForUpdate(current.bookId, user.id);
          if (!book) {
            throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
          }
          if (book.status !== 'читається') {
            throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Запис не можна видалити');
          }

          const bookRecords = (await repositories.readingRecords.listByUser(user.id))
            .filter((item) => item.bookId === book.id);
          const isLastRecord = bookRecords.every(
            (item) => item.id === current.id || item.endPage <= current.endPage,
          );
          if (!isLastRecord) {
            throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Видалення заборонене');
          }
          const deletedRecord = await repositories.readingRecords.deleteForUser(
            current.id,
            user.id,
          );
          if (!deletedRecord) {
            throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
          }
          if (bookRecords.length === 1) {
            const updatedBook = await repositories.books.updateStatusForUser(
              book.id,
              user.id,
              'розпочати',
            );
            if (!updatedBook) {
              throw new Error('Book disappeared during reading-record deletion');
            }
          }
        });
        status = 204;
        outcome = 'success';
        noContent = true;
      }
    } else if (
      (pathname === '/api/books' && ['GET', 'POST'].includes(request.method)) ||
      (/^\/api\/books\/[^/]+$/.test(pathname) && ['GET', 'PATCH', 'DELETE'].includes(request.method))
    ) {
      const user = await authenticateRequest(request, store);
      actorId = user.id;

      if (pathname === '/api/books') {
        if (request.method === 'POST') {
          action = 'books.create';
          const payload = await readJsonBody(request);
          validateBookShape(payload);
          const book = await store.books.create({
            userId: user.id,
            title: payload.title,
            author: payload.author,
            totalPages: payload.totalPages,
          });
          status = 201;
          outcome = 'success';
          body = { data: publicBook(book) };
        } else {
          action = 'books.list';
          const pageValue = url.searchParams.get('page') ?? '1';
          if (!/^[1-9]\d*$/.test(pageValue)) {
            throw new ApiProblem(400, 'INVALID_PARAMETER', 'Bad Request', 'Некоректний номер сторінки');
          }
          const page = Number(pageValue);
          const books = await store.books.listByUser(user.id);
          const pageSize = 16;
          const totalItems = books.length;
          const totalPages = Math.ceil(totalItems / pageSize);
          status = 200;
          outcome = 'success';
          body = {
            data: books.slice((page - 1) * pageSize, page * pageSize).map(publicBook),
            pagination: { page, pageSize, totalItems, totalPages },
          };
        }
      } else {
        const bookId = pathname.slice('/api/books/'.length);
        action = request.method === 'GET'
          ? 'books.read'
          : request.method === 'PATCH'
            ? 'books.update'
            : 'books.delete';
        if (request.method === 'DELETE') {
          await store.transaction(async (repositories) => {
            const book = await repositories.books.findByIdForUserForUpdate(bookId, user.id);
            if (!book) {
              throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
            }
            const deletedBook = await repositories.books.deleteForUser(book.id, user.id);
            if (!deletedBook) {
              throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
            }
          });
          status = 204;
          outcome = 'success';
          noContent = true;
        } else {
          const book = await store.books.findByIdForUser(bookId, user.id);
          if (!book) {
            throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
          }
          if (request.method === 'PATCH') {
            const changes = await readJsonBody(request);
            validateBookPatchShape(changes);

            if ('totalPages' in changes) {
              const records = await store.readingRecords.listByUser(user.id);
              if (records.some((record) => record.bookId === book.id)) {
                throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Кількість сторінок не можна змінити після початку читання');
              }
            }
            if ('rating' in changes && book.status !== 'прочитано') {
              throw new ApiProblem(409, 'STATE_CONFLICT', 'Конфлікт стану', 'Рейтинг доступний лише для прочитаної книги');
            }

            const updatedBook = await store.books.updateForUser(book.id, user.id, changes);
            if (!updatedBook) {
              throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
            }
            status = 200;
            outcome = 'success';
            body = { data: publicBook(updatedBook) };
          } else {
            status = 200;
            outcome = 'success';
            body = { data: publicBook(book) };
          }
        }
      }
    } else {
      throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
    }
  } catch (error) {
    body = toProblem(error, pathname);
    status = body.status;
    contentType = 'application/problem+json; charset=utf-8';
    noContent = false;
  }

  try {
    await logger.logAction({
      action,
      actorId,
      method: request.method ?? 'UNKNOWN',
      path: pathname,
      status,
      outcome,
    });
  } catch (error) {
    body = toProblem(error, pathname);
    status = 500;
    contentType = 'application/problem+json; charset=utf-8';
    noContent = false;
    responseHeaders = {};
  }

  if (noContent) {
    sendNoContent(response, responseHeaders);
  } else {
    const serialized = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(serialized),
      ...responseHeaders,
    });
    response.end(serialized);
  }
}

module.exports = { createApiServer };
