'use strict';

const { createServer } = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { verifyPassword } = require('../security/password-hasher.js');
const { createActionLogger } = require('../observability/action-logger.js');
const { RegistrationError, registerUser } = require('../application/registration-service.js');

const REGISTER_PATH = '/api/auth/register';
const LOGIN_PATH = '/api/auth/login';
const LOGOUT_PATH = '/api/auth/logout';
const SESSION_COOKIE = 'pt_session';
const ALLOWED_REGISTRATION_FIELDS = new Set(['email', 'password']);

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
    } else if (
      (pathname === '/api/books' && request.method === 'GET') ||
      (/^\/api\/books\/[^/]+$/.test(pathname) && ['GET', 'PATCH'].includes(request.method))
    ) {
      const user = await authenticateRequest(request, store);
      actorId = user.id;

      if (pathname === '/api/books') {
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
          data: books.slice((page - 1) * pageSize, page * pageSize),
          pagination: { page, pageSize, totalItems, totalPages },
        };
      } else {
        const bookId = pathname.slice('/api/books/'.length);
        action = request.method === 'GET' ? 'books.read' : 'books.update';
        const book = await store.books.findByIdForUser(bookId, user.id);
        if (!book) {
          throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
        }
        if (request.method === 'PATCH') {
          throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
        }
        status = 200;
        outcome = 'success';
        body = { data: book };
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
