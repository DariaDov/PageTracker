'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyPassword } = require('../src/security/password-hasher.js');

function createMemoryStore() {
  const users = [];
  let nextId = 1;
  const createCalls = [];

  return {
    createCalls,
    users: {
      async findByEmail(email) {
        return users.find((user) => user.email === email) ?? null;
      },
      async create({ email, passwordHash }) {
        createCalls.push({ email, passwordHash });
        if (users.some((user) => user.email === email)) {
          const error = new Error('duplicate key');
          error.code = '23505';
          error.constraint = 'users_email_key';
          throw error;
        }

        const user = { id: `user-${nextId++}`, email, passwordHash };
        users.push(user);
        return user;
      },
      count() {
        return users.length;
      },
    },
  };
}

function createMemoryLogger() {
  const events = [];
  return {
    events,
    logAction(event) {
      events.push(event);
    },
  };
}

async function startApi(t, store = createMemoryStore(), logger = createMemoryLogger()) {
  const { createApiServer } = require('../src/api/server.js');
  const server = createApiServer({ store, logger });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  return {
    store,
    logger,
    url: `http://127.0.0.1:${address.port}/api/auth/register`,
  };
}

async function register(url, body, options = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.rawBody ?? JSON.stringify(body),
  });
}

async function problem(response, expectedStatus, expectedCode) {
  assert.equal(response.status, expectedStatus);
  assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/);
  const result = await response.json();
  assert.equal(result.status, expectedStatus);
  assert.equal(result.code, expectedCode);
  assert.equal(typeof result.title, 'string');
  assert.equal(typeof result.detail, 'string');
  assert.equal(result.instance, '/api/auth/register');
  return result;
}

test('TEST-02 / REQ-F-019, REQ-F-022, REQ-F-023, REQ-F-041: registration creates a public account without starting a session', async (t) => {
  const { store, url } = await startApi(t);
  const password = 'x';
  const response = await register(url, { email: 'not-an-email', password });

  assert.equal(response.status, 201);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(response.headers.get('set-cookie'), null);
  const result = await response.json();
  assert.equal(typeof result.data.user.id, 'string');
  assert.equal(result.data.user.email, 'not-an-email');
  assert.deepEqual(Object.keys(result.data.user).sort(), ['email', 'id']);
  assert.equal(store.users.count(), 1);
  assert.equal(store.createCalls.length, 1);
  assert.notEqual(store.createCalls[0].passwordHash, password);
  assert.equal(await verifyPassword(password, store.createCalls[0].passwordHash), true);
});

test('TEST-02 / REQ-F-021: email uniqueness is case-sensitive', async (t) => {
  const { store, url } = await startApi(t);
  const first = await register(url, { email: 'Reader@example.com', password: 'a' });
  const second = await register(url, { email: 'reader@example.com', password: 'b' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(store.users.count(), 2);
  assert.deepEqual(
    store.createCalls.map(({ email }) => email),
    ['Reader@example.com', 'reader@example.com'],
  );
});

test('TEST-02 / REQ-F-042: missing and whitespace-only credentials are rejected without storing an account', async (t) => {
  const { store, url } = await startApi(t);
  const invalidBodies = [
    { password: 'valid' },
    { email: 'reader@example.com' },
    { email: '   ', password: 'valid' },
    { email: 'reader@example.com', password: '   ' },
    { email: '   ', password: '   ' },
  ];

  for (const body of invalidBodies) {
    const response = await register(url, body);
    await problem(response, 422, 'VALIDATION_ERROR');
    assert.equal(store.users.count(), 0);
    assert.equal(store.createCalls.length, 0);
  }
});

test('TEST-02 / REQ-F-030, API-CL-08: duplicate exact email returns the approved conflict without a second account', async (t) => {
  const { store, url } = await startApi(t);
  const body = { email: 'Reader@example.com', password: 'first' };
  assert.equal((await register(url, body)).status, 201);

  const response = await register(url, { ...body, password: 'second' });
  const result = await problem(response, 409, 'EMAIL_ALREADY_EXISTS');

  assert.equal(result.detail, 'Неправильні дані');
  assert.equal(store.users.count(), 1);
  assert.equal(store.createCalls.length, 1);
});

test('TEST-02 / API-CL-05, API-CL-06: malformed JSON returns the shared 400 problem response without mutation', async (t) => {
  const { store, url } = await startApi(t);
  const response = await register(url, null, { rawBody: '{"email":' });
  const result = await problem(response, 400, 'INVALID_JSON');

  assert.equal(result.status, 400);
  assert.equal(store.users.count(), 0);
  assert.equal(store.createCalls.length, 0);
});

test('TEST-02 / API-CL-09: unknown request fields are rejected without mutation', async (t) => {
  const { store, url } = await startApi(t);
  const response = await register(url, {
    email: 'reader@example.com',
    password: 'secret',
    ownerId: 'client-controlled',
  });
  await problem(response, 400, 'INVALID_PARAMETER');

  assert.equal(store.users.count(), 0);
  assert.equal(store.createCalls.length, 0);
});

test('TEST-02 / OpenAPI 500: storage failure returns a safe problem response without partial account data', async (t) => {
  const store = createMemoryStore();
  const logger = createMemoryLogger();
  store.users.create = async () => {
    throw new Error('internal database diagnostic');
  };
  const { url } = await startApi(t, store, logger);
  const response = await register(url, {
    email: 'reader@example.com',
    password: 'private-test-password',
  });
  const result = await problem(response, 500, 'INTERNAL_ERROR');

  assert.equal(result.detail, 'Помилка');
  assert.equal(JSON.stringify(result).includes('internal database diagnostic'), false);
  assert.equal(store.users.count(), 0);
  assert.equal(logger.events.length, 1);
  assert.equal(JSON.stringify(logger.events[0]).includes('internal database diagnostic'), false);
  assert.equal(JSON.stringify(logger.events[0]).includes('private-test-password'), false);
});

test('TEST-02 / action logging: successful and rejected registration requests are logged without credentials', async (t) => {
  const store = createMemoryStore();
  const logger = createMemoryLogger();
  const { url } = await startApi(t, store, logger);
  const email = 'reader@example.com';
  const password = 'private-test-password';
  assert.equal((await register(url, { email, password })).status, 201);
  await register(url, { email, password: 'another-password' });
  await register(url, { email: '   ', password: '   ' });

  assert.equal(logger.events.length, 3);
  assert.deepEqual(
    logger.events.map(({ status, outcome }) => ({ status, outcome })),
    [
      { status: 201, outcome: 'success' },
      { status: 409, outcome: 'failure' },
      { status: 422, outcome: 'failure' },
    ],
  );
  for (const event of logger.events) {
    assert.equal(event.action, 'auth.register');
    assert.equal(event.method, 'POST');
    assert.equal(event.path, '/api/auth/register');
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(email), false);
    assert.equal(serialized.includes(password), false);
    assert.equal(serialized.includes('another-password'), false);
    assert.equal(serialized.includes('session'), false);
  }
});
