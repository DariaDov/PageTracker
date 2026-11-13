'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { getDateInKyiv } = require('../src/time/kyiv-date.js');

function parseDate(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  const shifted = parseDate(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return formatDate(shifted);
}

function getWeekBounds(date) {
  const daysSinceMonday = (parseDate(date).getUTCDay() + 6) % 7;
  return {
    startDate: shiftDate(date, -daysSinceMonday),
    endDate: shiftDate(date, 6 - daysSinceMonday),
  };
}

function createMemoryStore({ failGoalWrite = false } = {}) {
  const users = [
    { id: 'user-a', email: 'a@example.test' },
    { id: 'user-b', email: 'b@example.test' },
  ];
  const sessions = new Map([
    [createHash('sha256').update('session-a').digest('hex'), { userId: 'user-a' }],
    [createHash('sha256').update('session-b').digest('hex'), { userId: 'user-b' }],
  ]);
  const books = [
    { id: 'book-a', userId: 'user-a' },
    { id: 'book-b', userId: 'user-b' },
  ];
  const records = [];
  const goalRows = new Map();
  const goalKey = (userId, period) => `${userId}:${period}`;

  const repositories = {
    users: {
      async findById(id) {
        return users.find((user) => user.id === id) ?? null;
      },
      async findByEmail(email) {
        return users.find((user) => user.email === email) ?? null;
      },
      async create(user) {
        const created = { id: randomUUID(), ...user };
        users.push(created);
        return created;
      },
    },
    sessions: {
      async findByTokenHash(tokenHash) {
        return sessions.get(tokenHash) ?? null;
      },
    },
    books: {
      async listByUser(userId) {
        return books.filter((book) => book.userId === userId);
      },
      async findByIdForUser(bookId, userId) {
        return books.find((book) => book.id === bookId && book.userId === userId) ?? null;
      },
      async findByIdForUserForUpdate(bookId, userId) {
        return books.find((book) => book.id === bookId && book.userId === userId) ?? null;
      },
      async deleteForUser(bookId, userId) {
        const book = books.find((item) => item.id === bookId && item.userId === userId);
        if (!book) {
          return null;
        }
        books.splice(books.indexOf(book), 1);
        for (let index = records.length - 1; index >= 0; index -= 1) {
          if (records[index].bookId === bookId) {
            records.splice(index, 1);
          }
        }
        return { id: bookId };
      },
    },
    readingRecords: {
      async listByUser(userId) {
        return records.filter((record) =>
          books.some((book) => book.id === record.bookId && book.userId === userId),
        );
      },
    },
    readingGoals: {
      async listByUser(userId) {
        return [...goalRows.values()].filter((goal) => goal.userId === userId);
      },
      async findByPeriodForUser(period, userId) {
        return goalRows.get(goalKey(userId, period)) ?? null;
      },
      async upsertForUser(userId, period, targetPages) {
        const goal = { userId, period, targetPages };
        goalRows.set(goalKey(userId, period), goal);
        if (failGoalWrite) {
          throw new Error('simulated reading goal storage failure');
        }
        return goal;
      },
      async deleteForUser(period, userId) {
        const goal = goalRows.get(goalKey(userId, period)) ?? null;
        goalRows.delete(goalKey(userId, period));
        if (failGoalWrite) {
          throw new Error('simulated reading goal storage failure');
        }
        return goal;
      },
    },
  };

  return {
    ...repositories,
    async transaction(operation) {
      const goalSnapshot = new Map(
        [...goalRows].map(([key, value]) => [key, { ...value }]),
      );
      const bookSnapshot = books.map((book) => ({ ...book }));
      const recordSnapshot = records.map((record) => ({ ...record }));
      try {
        return await operation(repositories);
      } catch (error) {
        goalRows.clear();
        for (const [key, value] of goalSnapshot) {
          goalRows.set(key, value);
        }
        books.splice(0, books.length, ...bookSnapshot);
        records.splice(0, records.length, ...recordSnapshot);
        throw error;
      }
    },
    goalRows,
    recordRows: records,
    seedGoal(userId, period, targetPages) {
      const goal = { userId, period, targetPages };
      goalRows.set(goalKey(userId, period), goal);
      return goal;
    },
    seedRecord({ userId = 'user-a', bookId, date, pagesRead }) {
      const ownerBook = bookId
        ? books.find((book) => book.id === bookId)
        : books.find((book) => book.userId === userId);
      assert.ok(ownerBook, `missing test book for ${userId}`);
      records.push({ id: randomUUID(), bookId: ownerBook.id, date, pagesRead });
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
  let closed = false;
  const close = () => {
    if (closed) {
      return Promise.resolve();
    }
    closed = true;
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  t.after(close);
  return { baseUrl: `http://127.0.0.1:${server.address().port}/api`, store, logger, close };
}

async function request(baseUrl, path, method = 'GET', body, session = 'session-a') {
  const headers = {};
  if (session) {
    headers.cookie = `pt_session=${session}`;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function assertProblem(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/);
  const problem = await response.json();
  assert.equal(problem.status, status);
  assert.equal(problem.code, code);
  return problem;
}

async function setGoal(baseUrl, period, targetPages, session = 'session-a') {
  return request(
    baseUrl,
    `/reading-goals/${period}`,
    'PUT',
    { targetPages },
    session,
  );
}

async function getStatistics(baseUrl, query = '', session = 'session-a') {
  return request(baseUrl, `/statistics${query}`, 'GET', undefined, session);
}

test('TEST-13 / REQ-F-044: goals can be read, set, and kept independently by period', async (t) => {
  const { baseUrl, logger } = await startApi(t);
  const initial = await request(baseUrl, '/reading-goals');
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).data, { week: null, month: null });

  const weekly = await setGoal(baseUrl, 'week', 100);
  assert.equal(weekly.status, 200);
  assert.deepEqual((await weekly.json()).data, { targetPages: 100 });
  assert.equal((await setGoal(baseUrl, 'month', 1)).status, 200);
  const monthly = await setGoal(baseUrl, 'month', 500);
  assert.equal(monthly.status, 200);
  assert.equal((await setGoal(baseUrl, 'month', 2147483647)).status, 200);

  const result = await request(baseUrl, '/reading-goals');
  assert.deepEqual((await result.json()).data, {
    week: { targetPages: 100 },
    month: { targetPages: 2147483647 },
  });
  assert.equal(logger.events.at(-1).action, 'reading-goals.read');
  assert.equal(logger.events.at(-1).outcome, 'success');
});

test('TEST-13 / REQ-F-044, REQ-NF-010: invalid goal values and periods are rejected without changing the saved goal', async (t) => {
  const { baseUrl } = await startApi(t);
  assert.equal((await setGoal(baseUrl, 'week', 250)).status, 200);

  for (const targetPages of [0, -1, 1.5, '100', 2147483648, null]) {
    await assertProblem(await setGoal(baseUrl, 'week', targetPages), 422, 'VALIDATION_ERROR');
  }
  await assertProblem(
    await request(baseUrl, '/reading-goals/week', 'PUT', {}),
    422,
    'VALIDATION_ERROR',
  );
  await assertProblem(
    await request(baseUrl, '/reading-goals/week', 'PUT', { targetPages: 10, extra: true }),
    422,
    'VALIDATION_ERROR',
  );
  await assertProblem(
    await fetch(`${baseUrl}/reading-goals/week`, {
      method: 'PUT',
      headers: {
        cookie: 'pt_session=session-a',
        'content-type': 'application/json',
      },
      body: '{"targetPages":',
    }),
    400,
    'INVALID_JSON',
  );
  await assertProblem(await setGoal(baseUrl, 'year', 100), 422, 'VALIDATION_ERROR');
  await assertProblem(
    await request(baseUrl, '/reading-goals/%E0%A4%A', 'DELETE'),
    422,
    'VALIDATION_ERROR',
  );
  await assertProblem(
    await request(baseUrl, '/reading-goals/year', 'DELETE'),
    422,
    'VALIDATION_ERROR',
  );

  const saved = await request(baseUrl, '/reading-goals');
  assert.deepEqual((await saved.json()).data.week, { targetPages: 250 });
});

test('TEST-13 / REQ-F-001, REQ-F-044: goal routes require authentication and isolate users', async (t) => {
  const { baseUrl } = await startApi(t);
  await assertProblem(await request(baseUrl, '/reading-goals', 'GET', undefined, null), 401, 'AUTH_REQUIRED');
  await assertProblem(await setGoal(baseUrl, 'week', 100, null), 401, 'AUTH_REQUIRED');
  await assertProblem(
    await request(baseUrl, '/reading-goals/week', 'DELETE', undefined, null),
    401,
    'AUTH_REQUIRED',
  );

  assert.equal((await setGoal(baseUrl, 'week', 120)).status, 200);
  const userB = await request(baseUrl, '/reading-goals', 'GET', undefined, 'session-b');
  assert.deepEqual((await userB.json()).data, { week: null, month: null });
});

test('TEST-13 / REQ-F-044: deleting a goal is idempotent and preserves the other period', async (t) => {
  const { baseUrl, logger } = await startApi(t);
  await setGoal(baseUrl, 'week', 80);
  await setGoal(baseUrl, 'month', 300);

  const firstDelete = await request(baseUrl, '/reading-goals/week', 'DELETE');
  assert.equal(firstDelete.status, 204);
  const repeatedDelete = await request(baseUrl, '/reading-goals/week', 'DELETE');
  assert.equal(repeatedDelete.status, 204);
  assert.equal(await repeatedDelete.text(), '');

  const result = await request(baseUrl, '/reading-goals');
  assert.deepEqual((await result.json()).data, {
    week: null,
    month: { targetPages: 300 },
  });
  assert.ok(logger.events.some(
    (event) => event.action === 'reading-goals.delete' && event.outcome === 'success',
  ));
  assert.equal(logger.events.at(-1).action, 'reading-goals.read');
});

test('TEST-13 / REQ-F-045: current-week progress includes current-period records and excludes future and other-user records', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const today = getDateInKyiv();
  const bounds = getWeekBounds(today);
  await setGoal(baseUrl, 'week', 100);
  store.seedRecord({ date: bounds.startDate, pagesRead: 40 });
  store.seedRecord({ date: today, pagesRead: 60 });
  store.seedRecord({ date: shiftDate(today, 1), pagesRead: 200 });
  store.seedRecord({ date: shiftDate(bounds.startDate, -1), pagesRead: 300 });
  store.seedRecord({ userId: 'user-b', date: today, pagesRead: 500 });

  const response = await getStatistics(baseUrl, `?period=week&date=${today}`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.goalProgress, {
    targetPages: 100,
    pagesRead: 100,
    remainingPages: 0,
    percentage: 100,
    achieved: true,
  });

  store.recordRows.find((record) => record.pagesRead === 60).pagesRead = 85;
  const exceeded = await getStatistics(baseUrl, `?period=week&date=${today}`);
  assert.deepEqual((await exceeded.json()).data.goalProgress, {
    targetPages: 100,
    pagesRead: 125,
    remainingPages: 0,
    percentage: 125,
    achieved: true,
  });
});

test('TEST-13 / REQ-F-045: current-month progress uses month boundaries and omits goals outside the current period', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const today = getDateInKyiv();
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  await setGoal(baseUrl, 'month', 40);
  store.seedRecord({ date: firstOfMonth, pagesRead: 10 });
  store.seedRecord({ date: today, pagesRead: 30 });

  const currentMonth = await getStatistics(baseUrl, `?period=month&date=${today}`);
  assert.equal((await currentMonth.json()).data.goalProgress.pagesRead, 40);

  const currentYear = await getStatistics(baseUrl, `?period=year&date=${today}`);
  assert.equal(Object.hasOwn((await currentYear.json()).data, 'goalProgress'), false);
  const previousWeek = await getStatistics(
    baseUrl,
    `?period=week&date=${shiftDate(today, -8)}`,
  );
  assert.equal(Object.hasOwn((await previousWeek.json()).data, 'goalProgress'), false);
});

test('TEST-13 / REQ-F-045: absent goals omit progress and updated records are reflected immediately', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const today = getDateInKyiv();
  store.seedRecord({ date: today, pagesRead: 15 });

  const withoutGoal = await getStatistics(baseUrl);
  assert.equal(Object.hasOwn((await withoutGoal.json()).data, 'goalProgress'), false);

  await setGoal(baseUrl, 'week', 20);
  store.seedRecord({ date: today, pagesRead: 5 });
  const afterCreate = await getStatistics(baseUrl);
  assert.equal((await afterCreate.json()).data.goalProgress.pagesRead, 20);

  store.recordRows[0].pagesRead = 18;
  const afterEdit = await getStatistics(baseUrl);
  assert.equal((await afterEdit.json()).data.goalProgress.pagesRead, 23);

  store.recordRows.splice(0, 1);
  const afterDelete = await getStatistics(baseUrl);
  assert.equal((await afterDelete.json()).data.goalProgress.pagesRead, 5);

  const deleteBook = await request(baseUrl, '/books/book-a', 'DELETE');
  assert.equal(deleteBook.status, 204);
  const afterBookDelete = await getStatistics(baseUrl);
  assert.deepEqual((await afterBookDelete.json()).data.goalProgress, {
    targetPages: 20,
    pagesRead: 0,
    remainingPages: 20,
    percentage: 0,
    achieved: false,
  });
});

test('TEST-13 / REQ-NF-010: failed goal writes roll back, return safe errors, and are logged', async (t) => {
  const store = createMemoryStore({ failGoalWrite: true });
  store.seedGoal('user-a', 'week', 75);
  const logger = createMemoryLogger();
  const { baseUrl } = await startApi(t, store, logger);

  const response = await setGoal(baseUrl, 'week', 200);
  const problem = await assertProblem(response, 500, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(problem).includes('simulated reading goal storage failure'), false);
  assert.equal(store.goalRows.get('user-a:week').targetPages, 75);
  assert.equal(logger.events.at(-1).action, 'reading-goals.update');
  assert.equal(logger.events.at(-1).outcome, 'failure');
});

test('TEST-13 / REQ-NF-010: failed goal deletion leaves the saved goal intact', async (t) => {
  const store = createMemoryStore({ failGoalWrite: true });
  store.seedGoal('user-a', 'month', 400);
  const logger = createMemoryLogger();
  const { baseUrl } = await startApi(t, store, logger);
  await assertProblem(
    await request(baseUrl, '/reading-goals/month', 'DELETE'),
    500,
    'INTERNAL_ERROR',
  );
  assert.equal(store.goalRows.get('user-a:month').targetPages, 400);
  assert.equal(logger.events.at(-1).action, 'reading-goals.delete');
  assert.equal(logger.events.at(-1).outcome, 'failure');
});

function findElement(node, predicate) {
  if (!React.isValidElement(node)) {
    return null;
  }
  if (predicate(node)) {
    return node;
  }
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findElement(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

test('TEST-13 / REQ-I-020: statistics UI shows goal progress and allows setting and removing goals in Ukrainian', () => {
  const changes = [];
  const removals = [];
  const props = {
    statistics: {
      period: { type: 'week', startDate: '2026-11-09', endDate: '2026-11-15' },
      daysCounted: 5,
      pagesReadTotal: 40,
      hasData: true,
      averagePagesPerDay: 8,
      goalProgress: {
        targetPages: 100,
        pagesRead: 40,
        remainingPages: 60,
        percentage: 40,
        achieved: false,
      },
    },
    readingGoals: { week: { targetPages: 100 }, month: null },
    selectedPeriod: 'week',
    selectedDate: '2026-11-13',
    onGoalChange: (goal) => changes.push(goal),
    onGoalDelete: (period) => removals.push(period),
  };
  const { StatisticsDashboard } = require('../src/ui/StatisticsDashboard.js');
  const element = React.createElement(StatisticsDashboard, props);
  const markup = renderToStaticMarkup(element);
  assert.match(markup, /Цілі читання/);
  assert.match(markup, /100/);
  assert.match(markup, /40/);
  assert.match(markup, /60/);
  assert.match(markup, /40%/);
  assert.match(markup, /Зберегти ціль/);
  assert.match(markup, /Прибрати ціль/);

  const tree = element.type(element.props);
  const goalForm = findElement(tree, (candidate) =>
    candidate.type === 'form' && candidate.props['data-form'] === 'reading-goal',
  );
  assert.ok(goalForm, 'expected a reading goal form');
  goalForm.props.onSubmit({
    preventDefault() {},
    currentTarget: {
      elements: {
        period: { value: 'month' },
        targetPages: { value: '500' },
      },
    },
  });
  assert.deepEqual(changes, [{ period: 'month', targetPages: 500 }]);

  const deleteButton = findElement(tree, (candidate) =>
    candidate.type === 'button' && candidate.props['data-action'] === 'delete-reading-goal',
  );
  assert.ok(deleteButton, 'expected a goal deletion action');
  deleteButton.props.onClick();
  assert.deepEqual(removals, ['week']);
});

test('TEST-13 / REQ-F-044, REQ-NF-004: PostgreSQL goals persist across store instances', {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : 'Set TEST_DATABASE_URL to run PostgreSQL persistence acceptance.',
}, async () => {
  const { createPostgresStore } = require('../src/infrastructure/postgres-store.js');
  const { hashPassword } = require('../src/security/password-hasher.js');
  const email = `goal-${randomUUID()}@example.test`;
  let store = await createPostgresStore({ connectionString: process.env.TEST_DATABASE_URL });
  let userId;
  let api;

  try {
    await store.migrate();
    const user = await store.users.create({
      email,
      passwordHash: await hashPassword('test-only-password'),
    });
    userId = user.id;
    api = await startApi({ after() {} }, store);
    const login = await request(
      api.baseUrl,
      '/auth/login',
      'POST',
      { email, password: 'test-only-password' },
      null,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie?.startsWith('pt_session='));
    const session = cookie.slice('pt_session='.length);

    assert.equal((await setGoal(api.baseUrl, 'week', 125, session)).status, 200);
    await api.close();
    api = null;
    await store.close();
    store = await createPostgresStore({ connectionString: process.env.TEST_DATABASE_URL });
    await store.migrate();
    api = await startApi({ after() {} }, store);

    const relogin = await request(
      api.baseUrl,
      '/auth/login',
      'POST',
      { email, password: 'test-only-password' },
      null,
    );
    assert.equal(relogin.status, 200);
    const newCookie = relogin.headers.get('set-cookie')?.split(';', 1)[0];
    const newSession = newCookie.slice('pt_session='.length);
    const goals = await request(api.baseUrl, '/reading-goals', 'GET', undefined, newSession);
    assert.deepEqual((await goals.json()).data.week, { targetPages: 125 });
  } finally {
    if (api) {
      await api.close();
    }
    if (userId) {
      await store.users.deleteById(userId);
    }
    await store.close();
  }
});
