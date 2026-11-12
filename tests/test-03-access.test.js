'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { hashPassword } = require('../src/security/password-hasher.js');

function createMemoryStore() {
  const users = [];
  const sessions = new Map();
  const books = [];
  let bookUpdateCalls = 0;

  return {
    users: {
      async create(user) {
        users.push(user);
        return user;
      },
      async findByEmail(email) {
        return users.find((user) => user.email === email) ?? null;
      },
    },
    sessions: {
      async create({ userId, tokenHash }) {
        sessions.set(tokenHash, { userId, createdAt: Date.now() });
      },
      async findByTokenHash(tokenHash) {
        return sessions.get(tokenHash) ?? null;
      },
      async deleteByTokenHash(tokenHash) {
        sessions.delete(tokenHash);
      },
    },
    books: {
      async listByUser(userId) {
        return books.filter((book) => book.userId === userId);
      },
      async findByIdForUser(bookId, userId) {
        return books.find((book) => book.id === bookId && book.userId === userId) ?? null;
      },
      async updateForUser(bookId, userId, changes) {
        bookUpdateCalls += 1;
        const book = books.find((item) => item.id === bookId && item.userId === userId);
        if (!book) {
          return null;
        }
        Object.assign(book, changes);
        return book;
      },
    },
    seedBook(book) {
      books.push(book);
    },
    sessionCount() {
      return sessions.size;
    },
    sessionTokenHashes() {
      return [...sessions.keys()];
    },
    bookUpdateCalls() {
      return bookUpdateCalls;
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

  return {
    store,
    logger,
    baseUrl: `http://127.0.0.1:${server.address().port}/api`,
  };
}

async function seedUser(store, email, password) {
  const user = {
    id: randomUUID(),
    email,
    passwordHash: await hashPassword(password),
  };
  await store.users.create(user);
  return user;
}

async function requestJson(baseUrl, path, method, body, cookie) {
  const headers = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (cookie) {
    headers.cookie = cookie;
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(baseUrl, email, password) {
  return requestJson(baseUrl, '/auth/login', 'POST', { email, password });
}

function sessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'login should set a session cookie');
  return {
    header: setCookie,
    cookiePair: setCookie.split(';', 1)[0],
    value: setCookie.split(';', 1)[0].slice('pt_session='.length),
  };
}

async function assertProblem(response, status, code, detail) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/);
  const problem = await response.json();
  assert.equal(problem.status, status);
  assert.equal(problem.code, code);
  if (detail !== undefined) {
    assert.equal(problem.detail, detail);
  }
  return problem;
}

test('TEST-03 / REQ-F-020, REQ-I-009, REQ-NF-003, REQ-NF-005: successful login returns public user and persistent secure session cookie', async (t) => {
  const store = createMemoryStore();
  const password = 'reader-password';
  const user = await seedUser(store, 'reader@example.com', password);
  const { baseUrl } = await startApi(t, store);

  const response = await login(baseUrl, user.email, password);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const result = await response.json();

  assert.deepEqual(result.data.user, { id: user.id, email: user.email });
  assert.equal(JSON.stringify(result).includes(user.passwordHash), false);

  const cookie = sessionCookie(response);
  assert.match(cookie.header, /;\s*Path=\/api(?:;|$)/i);
  assert.match(cookie.header, /;\s*HttpOnly(?:;|$)/i);
  assert.match(cookie.header, /;\s*Secure(?:;|$)/i);
  assert.match(cookie.header, /;\s*SameSite=Lax(?:;|$)/i);
  assert.doesNotMatch(cookie.header, /;\s*(?:Max-Age|Expires)=/i);
  assert.ok(cookie.value.length > 0);
  assert.equal(store.sessionCount(), 1);
});

test('TEST-03 / REQ-F-030: unknown email and wrong password produce indistinguishable login failures without a cookie', async (t) => {
  const store = createMemoryStore();
  const password = 'correct-password';
  const user = await seedUser(store, 'reader@example.com', password);
  const { baseUrl } = await startApi(t, store);

  const unknownEmail = await login(baseUrl, 'missing@example.com', password);
  const wrongPassword = await login(baseUrl, user.email, 'wrong-password');
  const unknownProblem = await assertProblem(unknownEmail, 401, 'INVALID_CREDENTIALS', 'Неправильні дані');
  const wrongProblem = await assertProblem(wrongPassword, 401, 'INVALID_CREDENTIALS', 'Неправильні дані');

  assert.equal(unknownEmail.headers.get('set-cookie'), null);
  assert.equal(wrongPassword.headers.get('set-cookie'), null);
  assert.equal(unknownProblem.title, wrongProblem.title);
  assert.equal(unknownProblem.detail, wrongProblem.detail);
  assert.equal(store.sessionCount(), 0);
});

test('TEST-03 / REQ-F-001, REQ-NF-005: protected resources reject absent and unknown sessions', async (t) => {
  const { baseUrl } = await startApi(t);

  const noCookie = await requestJson(baseUrl, '/books', 'GET');
  const unknownToken = randomBytes(32).toString('base64url');
  const unknownCookie = await requestJson(
    baseUrl,
    '/books',
    'GET',
    undefined,
    `pt_session=${unknownToken}`,
  );

  await assertProblem(noCookie, 401, 'AUTH_REQUIRED');
  await assertProblem(unknownCookie, 401, 'AUTH_REQUIRED');
});

test('TEST-03 / REQ-F-001: authenticated users can list and read only their own books', async (t) => {
  const store = createMemoryStore();
  const userA = await seedUser(store, 'a@example.com', 'password-a');
  const userB = await seedUser(store, 'b@example.com', 'password-b');
  const bookA = { id: randomUUID(), userId: userA.id, title: 'Book A' };
  const bookB = { id: randomUUID(), userId: userB.id, title: 'Book B' };
  store.seedBook(bookA);
  store.seedBook(bookB);
  const { baseUrl } = await startApi(t, store);

  const loginResponse = await login(baseUrl, userA.email, 'password-a');
  assert.equal(loginResponse.status, 200);
  const { cookiePair } = sessionCookie(loginResponse);

  const listResponse = await requestJson(baseUrl, '/books', 'GET', undefined, cookiePair);
  assert.equal(listResponse.status, 200);
  const listResult = await listResponse.json();
  assert.deepEqual(listResult.data.map(({ id }) => id), [bookA.id]);

  const ownBook = await requestJson(baseUrl, `/books/${bookA.id}`, 'GET', undefined, cookiePair);
  assert.equal(ownBook.status, 200);
  assert.equal((await ownBook.json()).data.id, bookA.id);

  const foreignBook = await requestJson(baseUrl, `/books/${bookB.id}`, 'GET', undefined, cookiePair);
  await assertProblem(foreignBook, 404, 'NOT_FOUND');

  const foreignBookUpdate = await requestJson(
    baseUrl,
    `/books/${bookB.id}`,
    'PATCH',
    { title: 'Taken over by A' },
    cookiePair,
  );
  await assertProblem(foreignBookUpdate, 404, 'NOT_FOUND');
  assert.equal(bookB.title, 'Book B');
  assert.equal(store.bookUpdateCalls(), 0);
});

test('TEST-03 / REQ-F-029, REQ-NF-005, API-CL-04: logout invalidates session, clears cookie, and is idempotent', async (t) => {
  const store = createMemoryStore();
  const user = await seedUser(store, 'reader@example.com', 'reader-password');
  const { baseUrl } = await startApi(t, store);

  const loginResponse = await login(baseUrl, user.email, 'reader-password');
  assert.equal(loginResponse.status, 200);
  const { cookiePair } = sessionCookie(loginResponse);

  const logoutResponse = await requestJson(baseUrl, '/auth/logout', 'POST', undefined, cookiePair);
  assert.equal(logoutResponse.status, 204);
  assert.equal(await logoutResponse.text(), '');
  assert.match(logoutResponse.headers.get('set-cookie') ?? '', /pt_session=;/);
  assert.match(logoutResponse.headers.get('set-cookie') ?? '', /Max-Age=0/i);
  assert.equal(store.sessionCount(), 0);

  const afterLogout = await requestJson(baseUrl, '/books', 'GET', undefined, cookiePair);
  await assertProblem(afterLogout, 401, 'AUTH_REQUIRED');

  const repeatedLogout = await requestJson(baseUrl, '/auth/logout', 'POST');
  assert.equal(repeatedLogout.status, 204);
  assert.equal(await repeatedLogout.text(), '');
});

test('TEST-03 / action logging: authentication logs do not include passwords or session tokens', async (t) => {
  const store = createMemoryStore();
  const logger = createMemoryLogger();
  const password = 'private-password';
  const user = await seedUser(store, 'reader@example.com', password);
  const { baseUrl } = await startApi(t, store, logger);

  const response = await login(baseUrl, user.email, password);
  assert.equal(response.status, 200);
  const { cookiePair, value } = sessionCookie(response);
  const logoutResponse = await requestJson(baseUrl, '/auth/logout', 'POST', undefined, cookiePair);
  assert.equal(logoutResponse.status, 204);

  assert.ok(logger.events.length >= 2);
  for (const event of logger.events) {
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes(password), false);
    assert.equal(serialized.includes(value), false);
    assert.equal(serialized.includes(cookiePair), false);
  }
  assert.ok(logger.events.some(({ action, status }) => action === 'auth.login' && status === 200));
  assert.ok(logger.events.some(({ action, status }) => action === 'auth.logout' && status === 204));
});

test('TEST-03 / session storage: raw session tokens are never used as stored keys', async (t) => {
  const store = createMemoryStore();
  const user = await seedUser(store, 'reader@example.com', 'reader-password');
  const { baseUrl } = await startApi(t, store);

  const response = await login(baseUrl, user.email, 'reader-password');
  assert.equal(response.status, 200);
  const { value } = sessionCookie(response);
  const [storedTokenHash] = store.sessionTokenHashes();

  assert.ok(storedTokenHash);
  assert.notEqual(storedTokenHash, value);
  const session = await store.sessions.findByTokenHash(storedTokenHash);
  assert.ok(session);
  assert.equal(session.userId, user.id);
  assert.equal(session.token, undefined);
});
