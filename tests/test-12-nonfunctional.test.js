'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hashPassword } = require('../src/security/password-hasher.js');

function createLoadStore(users, books) {
  const sessions = new Map();
  const records = [];
  const repositories = {
    users: {
      async findByEmail(email) {
        return users.find((user) => user.email === email) ?? null;
      },
      async findById(id) {
        return users.find((user) => user.id === id) ?? null;
      },
      async create(user) {
        users.push(user);
        return user;
      },
    },
    sessions: {
      async create({ userId, tokenHash }) {
        sessions.set(tokenHash, { userId });
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
      async findByIdForUserForUpdate(bookId, userId) {
        return books.find((book) => book.id === bookId && book.userId === userId) ?? null;
      },
      async updateStatusForUser(bookId, userId, status) {
        const book = books.find((item) => item.id === bookId && item.userId === userId);
        if (!book) {
          return null;
        }
        book.status = status;
        return book;
      },
    },
    readingRecords: {
      async listByUser(userId) {
        return records.filter((record) =>
          books.some((book) => book.id === record.bookId && book.userId === userId),
        );
      },
      async create({ bookId, startPage, endPage, date }) {
        const record = {
          id: randomUUID(),
          bookId,
          startPage,
          endPage,
          pagesRead: endPage - startPage + 1,
          date,
        };
        records.push(record);
        return record;
      },
    },
    readingGoals: {
      async listByUser() {
        return [];
      },
    },
  };
  return {
    ...repositories,
    async transaction(operation) {
      const bookSnapshot = books.map((book) => ({ ...book }));
      const recordSnapshot = records.map((record) => ({ ...record }));
      try {
        return await operation(repositories);
      } catch (error) {
        books.splice(0, books.length, ...bookSnapshot);
        records.splice(0, records.length, ...recordSnapshot);
        throw error;
      }
    },
  };
}

async function startApi(store, logger) {
  const { createApiServer } = require('../src/api/server.js');
  const server = logger ? createApiServer({ store, logger }) : createApiServer({ store });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function runConcurrentBatch(t, name, operations) {
  const startedAt = performance.now();
  const outcomes = await Promise.allSettled(operations);
  const elapsedMilliseconds = performance.now() - startedAt;
  t.diagnostic(`${name}: 10 concurrent requests completed in ${elapsedMilliseconds.toFixed(1)} ms`);
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) {
    throw failure.reason;
  }
  assert.ok(
    elapsedMilliseconds <= 2000,
    `${name}: 10 concurrent requests took ${elapsedMilliseconds}ms`,
  );
  return {
    results: outcomes.map((outcome) => outcome.value),
    elapsedMilliseconds,
  };
}

async function verifyUserFlows(t, baseUrl, users, books, password) {
  const { results: loginResults } = await runConcurrentBatch(
    t,
    'login',
    users.map(async (user) => {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: user.email, password }),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
      assert.ok(cookie?.startsWith('pt_session='));
      return { user, cookie };
    }),
  );

  await runConcurrentBatch(
    t,
    'library listing',
    loginResults.map(async ({ cookie }) => {
      const response = await fetch(`${baseUrl}/books`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).pagination.totalItems, 1);
    }),
  );

  const { results: createdRecords } = await runConcurrentBatch(
    t,
    'reading-record creation',
    loginResults.map(async ({ user, cookie }, index) => {
      const response = await fetch(`${baseUrl}/books/${books[index].id}/reading-records`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ startPage: 1, endPage: 2 }),
      });
      assert.equal(response.status, 201);
      const { data } = await response.json();
      assert.equal(data.pagesRead, 2);
      assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(user.id, books[index].userId);
      return { cookie, date: data.date };
    }),
  );

  await runConcurrentBatch(
    t,
    'statistics',
    createdRecords.map(async ({ cookie, date }) => {
      const query = new URLSearchParams({ period: 'week', date });
      const response = await fetch(`${baseUrl}/statistics?${query}`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.pagesReadTotal, 2);
    }),
  );
}

test('TEST-12 / REQ-NF-002: ten concurrent users complete all timed API operations within two seconds', async (t) => {
  const password = 'test-password';
  const passwordHash = await hashPassword(password);
  const users = Array.from({ length: 10 }, (_, index) => ({
    id: `user-${index}`,
    email: `user-${index}@example.test`,
    passwordHash,
  }));
  const books = users.map((user, index) => ({
    id: `book-${index}`,
    userId: user.id,
    title: `Book ${index}`,
    author: 'Test Author',
    totalPages: 10,
    status: 'розпочати',
    rating: null,
  }));
  const api = await startApi(createLoadStore(users, books), { logAction() {} });
  t.after(() => api.close());
  await verifyUserFlows(t, api.baseUrl, users, books, password);
});

test('TEST-12 / REQ-NF-002: PostgreSQL-backed ten-user load stays within two seconds', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to run PostgreSQL performance acceptance.',
}, async (t) => {
  const { createPostgresStore } = require('../src/infrastructure/postgres-store.js');
  const store = await createPostgresStore({ connectionString: process.env.TEST_DATABASE_URL });
  const userIds = [];
  let api;

  try {
    await store.migrate();
    const password = 'test-password';
    const passwordHash = await hashPassword(password);
    const accounts = await store.transaction(async (repositories) => {
      const users = [];
      const books = [];
      for (let index = 0; index < 10; index += 1) {
        const user = await repositories.users.create({
          email: `test-12-${randomUUID()}@example.test`,
          passwordHash,
        });
        userIds.push(user.id);
        users.push(user);
        books.push(await repositories.books.create({
          userId: user.id,
          title: `Book ${index}`,
          author: 'Test Author',
          totalPages: 10,
        }));
      }
      return { users, books };
    });

    api = await startApi(store);
    await verifyUserFlows(t, api.baseUrl, accounts.users, accounts.books, password);
  } finally {
    if (api) {
      await api.close();
    }
    for (const userId of userIds) {
      await store.users.deleteById(userId);
    }
    await store.close();
  }
});

test('TEST-12 / REQ-NF-001: statistics and book details produce browser-ready SSR markup', () => {
  const { AuthenticatedLayout } = require('../src/ui/AuthenticatedLayout.js');
  const { StatisticsDashboard } = require('../src/ui/StatisticsDashboard.js');
  const { BookDetails } = require('../src/ui/BookDetails.js');
  const statisticsView = React.createElement(StatisticsDashboard, {
    statistics: {
      period: { type: 'week', startDate: '2026-11-09', endDate: '2026-11-15' },
      daysCounted: 4,
      pagesReadTotal: 8,
      hasData: true,
      averagePagesPerDay: 2,
    },
    onPeriodChange() {},
  });
  const detailsView = React.createElement(BookDetails, {
    book: {
      id: 'book-a',
      title: 'Кобзар',
      author: 'Тарас Шевченко',
      totalPages: 100,
      status: 'розпочати',
      rating: null,
    },
    records: [],
    onUpdate() {},
    onRate() {},
  });
  const statistics = renderToStaticMarkup(statisticsView);
  const details = renderToStaticMarkup(detailsView);
  const shell = renderToStaticMarkup(React.createElement(
    AuthenticatedLayout,
    { onLogout() {} },
    React.createElement('main', null, statisticsView, detailsView),
  ));

  assert.match(statistics, /class="statistics-dashboard"/);
  assert.match(statistics, /Статистика/);
  assert.match(statistics, /2026-11-09/);
  assert.match(details, /Кобзар/);
  assert.match(details, /Записи читання/);
  assert.match(details, /Записів читання ще немає/);
  assert.match(shell, /aria-label="Основна навігація"/);
  assert.match(shell, /Бібліотека/);
  assert.match(shell, /Статистика/);
});

test('TEST-12 / PostgreSQL DATE values retain their calendar date', () => {
  const { types } = require('pg');
  const { mapCalendarDate } = require('../src/infrastructure/postgres-date.js');
  const postgresDate = types.getTypeParser(1082, 'text')('2026-11-12');

  assert.equal(mapCalendarDate(postgresDate), '2026-11-12');
});
