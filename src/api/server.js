'use strict';

const { createServer } = require('node:http');
const { createActionLogger } = require('../observability/action-logger.js');
const { RegistrationError, registerUser } = require('../application/registration-service.js');

const REGISTER_PATH = '/api/auth/register';
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
  const pathname = new URL(request.url, 'http://localhost').pathname;
  let status = 500;
  let outcome = 'failure';
  let body;
  let contentType = 'application/json; charset=utf-8';

  try {
    if (pathname !== REGISTER_PATH || request.method !== 'POST') {
      throw new ApiProblem(404, 'NOT_FOUND', 'Not Found', 'Ресурс не знайдено');
    }

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
  } catch (error) {
    body = toProblem(error, pathname);
    status = body.status;
    contentType = 'application/problem+json; charset=utf-8';
  }

  try {
    await logger.logAction({
      action: pathname === REGISTER_PATH ? 'auth.register' : 'http.request',
      actorId: null,
      method: request.method ?? 'UNKNOWN',
      path: pathname,
      status,
      outcome,
    });
  } catch (error) {
    body = toProblem(error, pathname);
    status = 500;
    contentType = 'application/problem+json; charset=utf-8';
  }

  sendJson(response, status, body, contentType);
}

module.exports = { createApiServer };
