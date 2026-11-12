'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');

function createMemoryStore({ failStatusUpdate = false } = {}) {
  const users = [{ id: 'user-a', email: 'a@example.test' }];
  const sessions = new Map([
    [createHash('sha256').update('session-a').digest('hex'), { userId: 'user-a' }],
  ]);
  const books = [
    {
      id: 'book-a',
      userId: 'user-a',
      title: 'Кобзар',
      author: 'Тарас Шевченко',
      totalPages: 240,
      status: 'розпочати',
      rating: null,
    },
  ];
  const records = [];

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
      async updateStatusForUser(bookId, userId, status) {
        if (failStatusUpdate) {
          throw new Error('simulated status update failure');
        }
        const book = books.find((item) => item.id === bookId && item.userId === userId);
        if (!book) {
          return null;
        }
        book.status = status;
        return book;
      },
    },
    readingRecords: {
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
      async listByUser(userId) {
        return records.filter((record) =>
          books.some((book) => book.id === record.bookId && book.userId === userId),
        );
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
    bookRows: books,
    recordRows: records,
    seedRecord(record) {
      records.push(record);
    },
    seedBook(book) {
      books.push(book);
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
    baseUrl: `http://127.0.0.1:${server.address().port}/api`,
    store,
    logger,
  };
}

async function createRecord(baseUrl, body) {
  return fetch(`${baseUrl}/books/book-a/reading-records`, {
    method: 'POST',
    headers: {
      cookie: 'pt_session=session-a',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
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

function seedRecord(store, startPage, endPage, id = `record-${startPage}`) {
  store.seedRecord({
    id,
    bookId: 'book-a',
    startPage,
    endPage,
    pagesRead: endPage - startPage + 1,
    date: '2026-11-12',
  });
}

test('TEST-08 / REQ-F-025, REQ-F-036: the first reading entry must begin at page one', async (t) => {
  const { baseUrl, store } = await startApi(t);
  await assertProblem(
    await createRecord(baseUrl, { startPage: 2, endPage: 10 }),
    409,
    'STATE_CONFLICT',
    'Відсутні сторінки',
  );
  assert.equal(store.recordRows.length, 0);
  assert.equal(store.bookRows[0].status, 'розпочати');
});

test('TEST-08 / REQ-F-025: a valid first partial record changes status to reading', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const response = await createRecord(baseUrl, { startPage: 1, endPage: 10 });

  assert.equal(response.status, 201);
  assert.equal(store.bookRows[0].status, 'читається');
  assert.equal(store.recordRows.length, 1);
});

test('TEST-08 / REQ-F-036: the next record must start immediately after the previous range', async (t) => {
  const { baseUrl, store } = await startApi(t);
  seedRecord(store, 1, 10);
  store.bookRows[0].status = 'читається';
  const response = await createRecord(baseUrl, { startPage: 11, endPage: 20 });

  assert.equal(response.status, 201);
  assert.equal(store.recordRows.length, 2);
  assert.equal(store.bookRows[0].status, 'читається');
});

test('TEST-08 / REQ-F-036: a gap in later records returns 409 and preserves prior state', async (t) => {
  const { baseUrl, store } = await startApi(t);
  seedRecord(store, 1, 10);
  store.bookRows[0].status = 'читається';

  await assertProblem(
    await createRecord(baseUrl, { startPage: 12, endPage: 20 }),
    409,
    'STATE_CONFLICT',
    'Відсутні сторінки',
  );
  assert.equal(store.recordRows.length, 1);
  assert.equal(store.bookRows[0].status, 'читається');
});

test('TEST-08 / REQ-F-008: overlapping page ranges return 409 without a new record', async (t) => {
  const { baseUrl, store } = await startApi(t);
  seedRecord(store, 1, 10);
  store.bookRows[0].status = 'читається';

  await assertProblem(
    await createRecord(baseUrl, { startPage: 5, endPage: 15 }),
    409,
    'STATE_CONFLICT',
    'Ці сторінки вже прочитані',
  );
  assert.equal(store.recordRows.length, 1);
  assert.equal(store.recordRows[0].endPage, 10);
});

test('TEST-08 / REQ-F-009: an end page before the start page returns the specified validation error', async (t) => {
  const { baseUrl, store } = await startApi(t);
  await assertProblem(
    await createRecord(baseUrl, { startPage: 11, endPage: 10 }),
    422,
    'VALIDATION_ERROR',
    'Кінцева сторінка, менша за початкову',
  );
  assert.equal(store.recordRows.length, 0);
  assert.equal(store.bookRows[0].status, 'розпочати');
});

test('TEST-08 / REQ-F-010: non-integer or out-of-book pages return the specified validation error', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const invalidRanges = [
    { startPage: 0, endPage: 10 },
    { startPage: 1.5, endPage: 10 },
    { startPage: 1, endPage: 10.5 },
    { startPage: 1, endPage: 241 },
    { startPage: 241, endPage: 241 },
  ];

  for (const range of invalidRanges) {
    await assertProblem(
      await createRecord(baseUrl, range),
      422,
      'VALIDATION_ERROR',
      'Будь ласка, змініть сторінку',
    );
    assert.equal(store.recordRows.length, 0);
    assert.equal(store.bookRows[0].status, 'розпочати');
  }
});

test('TEST-08 / REQ-F-006: reading the final single page completes a book with pagesRead one', async (t) => {
  const { baseUrl, store } = await startApi(t);
  seedRecord(store, 1, 239);
  store.bookRows[0].status = 'читається';
  const response = await createRecord(baseUrl, { startPage: 240, endPage: 240 });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.pagesRead, 1);
  assert.equal(store.bookRows[0].status, 'прочитано');
  assert.equal(store.recordRows.length, 2);
});

test('TEST-08 / REQ-F-006: a one-page book completes on its first and only page', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.bookRows[0].totalPages = 1;
  const response = await createRecord(baseUrl, { startPage: 1, endPage: 1 });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.pagesRead, 1);
  assert.equal(store.bookRows[0].status, 'прочитано');
});

test('TEST-08 / REQ-F-006: completed books reject further records without state changes', async (t) => {
  const { baseUrl, store } = await startApi(t);
  seedRecord(store, 1, 240);
  store.bookRows[0].status = 'прочитано';
  store.bookRows[0].rating = 5;

  await assertProblem(
    await createRecord(baseUrl, { startPage: 241, endPage: 241 }),
    409,
    'STATE_CONFLICT',
  );
  assert.equal(store.recordRows.length, 1);
  assert.equal(store.bookRows[0].status, 'прочитано');
  assert.equal(store.bookRows[0].rating, 5);
});

test('TEST-08 / REQ-NF-006: failure updating status rolls back the inserted reading record', async (t) => {
  const store = createMemoryStore({ failStatusUpdate: true });
  const { baseUrl } = await startApi(t, store);
  const response = await createRecord(baseUrl, { startPage: 1, endPage: 10 });

  await assertProblem(response, 500, 'INTERNAL_ERROR');
  assert.equal(store.recordRows.length, 0);
  assert.equal(store.bookRows[0].status, 'розпочати');
});

test('TEST-08 / action logging: state transitions do not log request payload', async (t) => {
  const { baseUrl, logger } = await startApi(t);
  const response = await createRecord(baseUrl, { startPage: 1, endPage: 10 });
  assert.equal(response.status, 201);

  const event = logger.events.at(-1);
  assert.equal(event.action, 'reading-records.create');
  assert.equal(event.status, 201);
  assert.equal(event.outcome, 'success');
  assert.equal(Object.hasOwn(event, 'startPage'), false);
  assert.equal(Object.hasOwn(event, 'endPage'), false);
});
