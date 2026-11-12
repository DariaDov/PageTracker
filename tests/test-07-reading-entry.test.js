'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { getDateInKyiv } = require('../src/time/kyiv-date.js');

function createMemoryStore({ failCreate = false } = {}) {
  const users = [
    { id: 'user-a', email: 'a@example.test' },
    { id: 'user-b', email: 'b@example.test' },
  ];
  const sessions = new Map([
    [createHash('sha256').update('session-a').digest('hex'), { userId: 'user-a' }],
    [createHash('sha256').update('session-b').digest('hex'), { userId: 'user-b' }],
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
    {
      id: 'book-active',
      userId: 'user-a',
      title: 'Читається',
      author: 'Автор',
      totalPages: 100,
      status: 'читається',
      rating: null,
    },
    {
      id: 'book-done',
      userId: 'user-a',
      title: 'Завершена',
      author: 'Автор',
      totalPages: 90,
      status: 'прочитано',
      rating: null,
    },
    {
      id: 'book-foreign',
      userId: 'user-b',
      title: 'Чужа книга',
      author: 'Інший автор',
      totalPages: 80,
      status: 'розпочати',
      rating: null,
    },
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
      async findByIdForUser(bookId, userId) {
        return books.find((book) => book.id === bookId && book.userId === userId) ?? null;
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
      async create({ bookId, startPage, endPage, date }) {
        if (failCreate) {
          throw new Error('simulated storage failure');
        }
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
    async transaction(operation) {
      return operation(this);
    },
    bookRows: books,
    recordRows: records,
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

async function createRecord(baseUrl, bookId, body, session = 'session-a') {
  const headers = { cookie: `pt_session=${session}` };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return fetch(`${baseUrl}/books/${bookId}/reading-records`, {
    method: 'POST',
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

test('TEST-07 / REQ-F-003, REQ-F-007: API computes pagesRead and the Europe/Kyiv date', async (t) => {
  const { baseUrl, store, logger } = await startApi(t);
  const before = getDateInKyiv();
  const response = await createRecord(baseUrl, 'book-a', { startPage: 1, endPage: 10 });
  const after = getDateInKyiv();

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.deepEqual(Object.keys(result.data).sort(), [
    'bookId',
    'date',
    'endPage',
    'id',
    'pagesRead',
    'startPage',
  ]);
  assert.equal(result.data.bookId, 'book-a');
  assert.equal(result.data.startPage, 1);
  assert.equal(result.data.endPage, 10);
  assert.equal(result.data.pagesRead, 10);
  assert.match(result.data.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok([before, after].includes(result.data.date));
  assert.equal(store.recordRows.length, 1);
  assert.deepEqual(logger.events.at(-1), {
    action: 'reading-records.create',
    actorId: 'user-a',
    method: 'POST',
    path: '/api/books/book-a/reading-records',
    status: 201,
    outcome: 'success',
  });
});

test('TEST-07 / REQ-F-003: multiple records for one book may share the same date', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const first = await createRecord(baseUrl, 'book-a', { startPage: 1, endPage: 10 });
  const second = await createRecord(baseUrl, 'book-a', { startPage: 11, endPage: 20 });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstRecord = (await first.json()).data;
  const secondRecord = (await second.json()).data;
  assert.equal(firstRecord.date, secondRecord.date);
  assert.notEqual(firstRecord.id, secondRecord.id);
  assert.equal(store.recordRows.length, 2);
});

test('TEST-07 / REQ-F-001: creating a reading record requires an authenticated session', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const response = await fetch(`${baseUrl}/books/book-a/reading-records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startPage: 1, endPage: 10 }),
  });

  await assertProblem(response, 401, 'AUTH_REQUIRED');
  assert.equal(store.recordRows.length, 0);
});

test('TEST-07 / REQ-F-001: foreign or missing books return the same 404 without a record', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const foreign = await createRecord(baseUrl, 'book-foreign', { startPage: 1, endPage: 10 });
  const missing = await createRecord(baseUrl, 'missing-book', { startPage: 1, endPage: 10 });

  const foreignProblem = await assertProblem(foreign, 404, 'NOT_FOUND');
  const missingProblem = await assertProblem(missing, 404, 'NOT_FOUND');
  assert.equal(foreignProblem.detail, missingProblem.detail);
  assert.equal(store.recordRows.length, 0);
});

test('TEST-07 / REQ-F-043: incomplete reading entry requests are rejected without persistence', async (t) => {
  const { baseUrl, store } = await startApi(t);
  for (const body of [{}, { startPage: 1 }, { endPage: 10 }]) {
    await assertProblem(
      await createRecord(baseUrl, 'book-a', body),
      422,
      'VALIDATION_ERROR',
    );
    assert.equal(store.recordRows.length, 0);
  }
});

test('TEST-07 / API-CL-05, API-CL-09: malformed JSON and client-supplied derived fields are rejected', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const malformed = await fetch(`${baseUrl}/books/book-a/reading-records`, {
    method: 'POST',
    headers: { cookie: 'pt_session=session-a', 'content-type': 'application/json' },
    body: '{"startPage":',
  });
  await assertProblem(malformed, 400, 'INVALID_JSON');

  for (const extra of [
    { date: '2000-01-01' },
    { pagesRead: 99 },
    { bookId: 'book-foreign' },
    { userId: 'user-b' },
  ]) {
    await assertProblem(
      await createRecord(baseUrl, 'book-a', { startPage: 1, endPage: 10, ...extra }),
      400,
      'INVALID_PARAMETER',
    );
    assert.equal(store.recordRows.length, 0);
  }
});

test('TEST-07 / OpenAPI 500: storage failure returns a safe problem without partial record data', async (t) => {
  const store = createMemoryStore({ failCreate: true });
  const { baseUrl, logger } = await startApi(t, store);
  const response = await createRecord(baseUrl, 'book-a', { startPage: 1, endPage: 10 });

  const problem = await assertProblem(response, 500, 'INTERNAL_ERROR');
  assert.equal(problem.detail, 'Помилка');
  assert.equal(store.recordRows.length, 0);
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
    const result = findElement(child, predicate);
    if (result) {
      return result;
    }
  }
  return null;
}

function renderEntryForm(props) {
  const { HomeReadingForm } = require('../src/ui/HomeReadingForm.js');
  const element = React.createElement(HomeReadingForm, props);
  return { element, markup: renderToStaticMarkup(element) };
}

const availableBooks = [
  { id: 'book-start', title: 'Почата', author: 'Автор', status: 'розпочати' },
  { id: 'book-reading', title: 'Читається', author: 'Автор', status: 'читається' },
  { id: 'book-done', title: 'Завершена', author: 'Автор', status: 'прочитано' },
];

test('TEST-07 / REQ-I-007, REQ-I-008: home form selects only books available for reading', () => {
  const { markup } = renderEntryForm({ books: availableBooks, onCreate() {} });

  assert.match(markup, /<form\b/);
  assert.match(markup, /Почата/);
  assert.match(markup, /Читається/);
  assert.doesNotMatch(markup, /Завершена/);
  assert.match(markup, /Початкова сторінка/);
  assert.match(markup, /Кінцева сторінка/);
});

test('TEST-07 / REQ-F-007, REQ-I-008: date and derived page count are not client inputs', () => {
  const { element, markup } = renderEntryForm({ books: availableBooks, onCreate() {} });
  assert.doesNotMatch(markup, /name="date"/);
  assert.doesNotMatch(markup, /name="pagesRead"/);
  const tree = element.type(element.props);
  assert.equal(findElement(tree, (candidate) =>
    candidate.type === 'input' && ['date', 'pagesRead'].includes(candidate.props.name),
  ), null);
});

test('TEST-07 / REQ-I-019: submitting the home form calls create with book and page bounds', () => {
  const submitted = [];
  const { element } = renderEntryForm({
    books: availableBooks,
    onCreate: (record) => submitted.push(record),
  });
  const form = findElement(element.type(element.props), (candidate) =>
    candidate.type === 'form',
  );
  assert.ok(form, 'expected a home reading form');
  form.props.onSubmit({
    preventDefault() {},
    currentTarget: {
      elements: {
        bookId: { value: 'book-reading' },
        startPage: { value: '11' },
        endPage: { value: '20' },
      },
    },
  });
  assert.deepEqual(submitted, [{
    bookId: 'book-reading',
    startPage: 11,
    endPage: 20,
  }]);
});
