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

function getPeriodBounds(period, referenceDate) {
  const date = parseDate(referenceDate);
  if (period === 'week') {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    return {
      startDate: shiftDate(referenceDate, -daysSinceMonday),
      endDate: shiftDate(referenceDate, 6 - daysSinceMonday),
    };
  }
  if (period === 'month') {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { startDate: formatDate(start), endDate: formatDate(end) };
  }
  return {
    startDate: `${date.getUTCFullYear()}-01-01`,
    endDate: `${date.getUTCFullYear()}-12-31`,
  };
}

function createMemoryStore({ failList = false } = {}) {
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
    { id: 'book-c', userId: 'user-a' },
    { id: 'book-b', userId: 'user-b' },
  ];
  const records = [];
  return {
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
    },
    readingRecords: {
      async listByUser(userId) {
        if (failList) {
          throw new Error('simulated statistics storage failure');
        }
        return records.filter((record) =>
          books.some((book) => book.id === record.bookId && book.userId === userId),
        );
      },
    },
    recordRows: records,
    seedRecord({ bookId = 'book-a', date, pagesRead }) {
      records.push({ id: randomUUID(), bookId, date, pagesRead });
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
  return { baseUrl: `http://127.0.0.1:${server.address().port}/api`, store, logger };
}

async function getStatistics(baseUrl, query = '', session = 'session-a') {
  return fetch(`${baseUrl}/statistics${query}`, {
    headers: { cookie: `pt_session=${session}` },
  });
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

test('TEST-11 / REQ-F-015, REQ-F-016, REQ-F-017: default week sums own books and excludes future days', async (t) => {
  const { baseUrl, store, logger } = await startApi(t);
  const today = getDateInKyiv();
  const bounds = getPeriodBounds('week', today);
  const dayNumber = Math.floor((parseDate(today) - parseDate(bounds.startDate)) / 86_400_000);
  store.seedRecord({ bookId: 'book-a', date: today, pagesRead: 7 });
  store.seedRecord({ bookId: 'book-c', date: today, pagesRead: 5 });
  store.seedRecord({ bookId: 'book-b', date: today, pagesRead: 500 });
  store.seedRecord({ bookId: 'book-a', date: shiftDate(bounds.startDate, -1), pagesRead: 100 });
  if (today < bounds.endDate) {
    store.seedRecord({ bookId: 'book-a', date: shiftDate(today, 1), pagesRead: 90 });
  }

  const response = await getStatistics(baseUrl);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.period, {
    type: 'week',
    startDate: bounds.startDate,
    endDate: bounds.endDate,
  });
  assert.equal(data.pagesReadTotal, 12);
  assert.equal(data.daysCounted, dayNumber + 1);
  assert.equal(data.averagePagesPerDay, Math.floor(12 / (dayNumber + 1) + 0.5));
  assert.equal(data.hasData, true);
  assert.equal(logger.events.at(-1).action, 'statistics.read');
});

test('TEST-11 / REQ-F-016, REQ-F-038: a past month uses all its days and rounds 0.5 upward', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.seedRecord({ date: '2025-11-02', pagesRead: 5 });
  store.seedRecord({ bookId: 'book-c', date: '2025-11-29', pagesRead: 10 });
  store.seedRecord({ date: '2025-10-31', pagesRead: 100 });

  const response = await getStatistics(baseUrl, '?period=month&date=2025-11-15');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.period, {
    type: 'month',
    startDate: '2025-11-01',
    endDate: '2025-11-30',
  });
  assert.equal(data.pagesReadTotal, 15);
  assert.equal(data.daysCounted, 30);
  assert.equal(data.averagePagesPerDay, 1);
});

test('TEST-11 / REQ-F-015, REQ-F-016: a past leap year returns its full calendar boundaries', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.seedRecord({ date: '2024-02-29', pagesRead: 12 });

  const response = await getStatistics(baseUrl, '?period=year&date=2024-06-15');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.period, {
    type: 'year',
    startDate: '2024-01-01',
    endDate: '2024-12-31',
  });
  assert.equal(data.daysCounted, 366);
  assert.equal(data.pagesReadTotal, 12);
});

test('TEST-11 / REQ-F-018, REQ-I-005: an empty period returns the approved no-data response', async (t) => {
  const { baseUrl } = await startApi(t);
  const response = await getStatistics(baseUrl, '?period=month&date=2025-02-10');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.hasData, false);
  assert.equal(data.pagesReadTotal, 0);
  assert.equal(data.averagePagesPerDay, null);
  assert.equal(data.message, 'Щоб побачити статистику, додайте новий запис');
  assert.equal(data.daysCounted, 28);
});

test('TEST-11 / OpenAPI: unsupported periods and invalid calendar dates return 400', async (t) => {
  const { baseUrl } = await startApi(t);
  await assertProblem(
    await getStatistics(baseUrl, '?period=day'),
    400,
    'INVALID_PARAMETER',
    'Період має бути week, month або year',
  );
  for (const date of ['invalid', '2024-02-30', '2024-2-2']) {
    await assertProblem(
      await getStatistics(baseUrl, `?date=${date}`),
      400,
      'INVALID_PARAMETER',
      'Дата має бути коректною календарною датою',
    );
  }
});

test('TEST-11 / TEST-GATE-11: reject a fully future period but allow a future date inside the current period', async (t) => {
  const { baseUrl } = await startApi(t);
  const today = getDateInKyiv();
  const currentWeek = getPeriodBounds('week', today);
  if (today < currentWeek.endDate) {
    const currentPeriodResponse = await getStatistics(
      baseUrl,
      `?period=week&date=${shiftDate(today, 1)}`,
    );
    assert.equal(currentPeriodResponse.status, 200);
  }

  const futureDates = [
    ['week', shiftDate(currentWeek.startDate, 7)],
    ['month', formatDate(new Date(Date.UTC(
      parseDate(today).getUTCFullYear(),
      parseDate(today).getUTCMonth() + 1,
      1,
    )))],
    ['year', `${parseDate(today).getUTCFullYear() + 1}-06-01`],
  ];
  for (const [period, date] of futureDates) {
    await assertProblem(
      await getStatistics(baseUrl, `?period=${period}&date=${date}`),
      400,
      'INVALID_PARAMETER',
      'Майбутній період недоступний',
    );
  }
});

test('TEST-11 / REQ-F-001: statistics require authentication', async (t) => {
  const { baseUrl } = await startApi(t);
  await assertProblem(
    await fetch(`${baseUrl}/statistics`),
    401,
    'AUTH_REQUIRED',
  );
});

test('TEST-11 / REQ-F-039: every read reflects changes to current records', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const today = getDateInKyiv();
  store.seedRecord({ date: today, pagesRead: 3 });
  const first = await getStatistics(baseUrl);
  assert.equal((await first.json()).data.pagesReadTotal, 3);

  store.recordRows[0].pagesRead = 8;
  const edited = await getStatistics(baseUrl);
  assert.equal((await edited.json()).data.pagesReadTotal, 8);

  store.recordRows.splice(0, 1);
  const deleted = await getStatistics(baseUrl);
  const result = await deleted.json();
  assert.equal(result.data.pagesReadTotal, 0);
  assert.equal(result.data.hasData, false);
});

test('TEST-11 / REQ-F-040: storage failures return a safe logged 500', async (t) => {
  const { baseUrl, logger } = await startApi(t, createMemoryStore({ failList: true }));
  const response = await getStatistics(baseUrl);
  const problem = await assertProblem(response, 500, 'INTERNAL_ERROR', 'Помилка');
  assert.equal(JSON.stringify(problem).includes('simulated statistics storage failure'), false);
  assert.equal(logger.events.at(-1).action, 'statistics.read');
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

test('TEST-11 / REQ-I-005: statistics page renders data, empty/error states, and period selection', () => {
  const selections = [];
  const props = {
    statistics: {
      period: { type: 'month', startDate: '2025-11-01', endDate: '2025-11-30' },
      daysCounted: 30,
      pagesReadTotal: 15,
      hasData: true,
      averagePagesPerDay: 1,
    },
    selectedPeriod: 'month',
    selectedDate: '2025-11-15',
    onPeriodChange: (selection) => selections.push(selection),
  };
  const { StatisticsDashboard } = require('../src/ui/StatisticsDashboard.js');
  const element = React.createElement(StatisticsDashboard, props);
  const markup = renderToStaticMarkup(element);
  assert.match(markup, /2025-11-01/);
  assert.match(markup, /2025-11-30/);
  assert.match(markup, /Середнє за день: 1/);
  assert.match(markup, /Днів у періоді: 30/);

  const tree = element.type(element.props);
  const form = findElement(tree, (candidate) =>
    candidate.type === 'form' && candidate.props['data-form'] === 'statistics-period',
  );
  assert.ok(form, 'expected a statistics period form');
  form.props.onSubmit({
    preventDefault() {},
    currentTarget: {
      elements: {
        period: { value: 'year' },
        date: { value: '2024-06-15' },
      },
    },
  });
  assert.deepEqual(selections, [{ period: 'year', date: '2024-06-15' }]);

  const empty = renderToStaticMarkup(React.createElement(StatisticsDashboard, {
    ...props,
    statistics: {
      ...props.statistics,
      hasData: false,
      averagePagesPerDay: null,
      message: 'Щоб побачити статистику, додайте новий запис',
    },
  }));
  assert.match(empty, /Щоб побачити статистику, додайте новий запис/);
  const error = renderToStaticMarkup(React.createElement(StatisticsDashboard, {
    ...props,
    error: true,
  }));
  assert.match(error, /Помилка/);
});
