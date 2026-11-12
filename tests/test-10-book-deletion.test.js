'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function createMemoryStore({ failDeleteAfterCascade = false } = {}) {
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
      totalPages: 30,
      status: 'читається',
      rating: null,
    },
    {
      id: 'book-b',
      userId: 'user-b',
      title: 'Інша книга',
      author: 'Інший автор',
      totalPages: 20,
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
      async findByIdForUserForUpdate(bookId, userId) {
        return books.find((book) => book.id === bookId && book.userId === userId) ?? null;
      },
      async deleteForUser(bookId, userId) {
        const index = books.findIndex((book) => book.id === bookId && book.userId === userId);
        if (index < 0) {
          return null;
        }
        books.splice(index, 1);
        for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex -= 1) {
          if (records[recordIndex].bookId === bookId) {
            records.splice(recordIndex, 1);
          }
        }
        if (failDeleteAfterCascade) {
          throw new Error('simulated delete failure after cascade');
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
    seedRecord({ id, bookId = 'book-a', startPage, endPage, date = '2026-11-12' }) {
      records.push({
        id: id ?? randomUUID(),
        bookId,
        startPage,
        endPage,
        pagesRead: endPage - startPage + 1,
        date,
      });
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

async function request(baseUrl, path, session = 'session-a') {
  return fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { cookie: `pt_session=${session}` },
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

test('TEST-10 / REQ-F-014, REQ-F-039: deleting a book removes it and all records from the owner data', async (t) => {
  const { baseUrl, store, logger } = await startApi(t);
  store.seedRecord({ id: 'record-a', startPage: 1, endPage: 10 });
  store.seedRecord({ id: 'record-b', startPage: 11, endPage: 20 });

  const response = await request(baseUrl, '/books/book-a');
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.deepEqual(store.bookRows.map((book) => book.id), ['book-b']);
  assert.equal(store.recordRows.length, 0);

  const libraryResponse = await fetch(`${baseUrl}/books`, {
    headers: { cookie: 'pt_session=session-a' },
  });
  assert.equal((await libraryResponse.json()).pagination.totalItems, 0);
  const details = await fetch(`${baseUrl}/books/book-a`, {
    headers: { cookie: 'pt_session=session-a' },
  });
  await assertProblem(details, 404, 'NOT_FOUND');
  const records = await fetch(`${baseUrl}/books/book-a/reading-records`, {
    headers: { cookie: 'pt_session=session-a' },
  });
  await assertProblem(records, 404, 'NOT_FOUND');

  assert.equal(logger.events[0].action, 'books.delete');
  assert.equal(logger.events[0].status, 204);
  assert.equal(logger.events[0].outcome, 'success');
  assert.equal(Object.hasOwn(logger.events[0], 'bookId'), false);
});

test('TEST-10 / REQ-F-001: deletion requires a session and hides foreign or missing books', async (t) => {
  const { baseUrl, store } = await startApi(t);

  await assertProblem(
    await fetch(`${baseUrl}/books/book-a`, { method: 'DELETE' }),
    401,
    'AUTH_REQUIRED',
  );
  const foreign = await request(baseUrl, '/books/book-b');
  const missing = await request(baseUrl, '/books/missing-book');
  const foreignProblem = await assertProblem(foreign, 404, 'NOT_FOUND');
  const missingProblem = await assertProblem(missing, 404, 'NOT_FOUND');
  assert.equal(foreignProblem.detail, missingProblem.detail);
  assert.deepEqual(store.bookRows.map((book) => book.id), ['book-a', 'book-b']);
});

test('TEST-10 / REQ-NF-006: a cascade storage failure rolls back the book and its records', async (t) => {
  const store = createMemoryStore({ failDeleteAfterCascade: true });
  const { baseUrl, logger } = await startApi(t, store);
  store.seedRecord({ id: 'record-a', startPage: 1, endPage: 10 });

  const response = await request(baseUrl, '/books/book-a');
  const problem = await assertProblem(response, 500, 'INTERNAL_ERROR');
  assert.equal(problem.detail, 'Помилка');
  assert.deepEqual(store.bookRows.map((book) => book.id), ['book-a', 'book-b']);
  assert.equal(store.recordRows.length, 1);
  assert.equal(logger.events.at(-1).action, 'books.delete');
  assert.equal(logger.events.at(-1).outcome, 'failure');
  assert.equal(Object.hasOwn(logger.events.at(-1), 'bookId'), false);
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

test('TEST-10 / REQ-F-014, REQ-I-017: book details confirm deletion and invoke return-to-library callback', () => {
  const deletions = [];
  const props = {
    book: {
      id: 'book-a',
      title: 'Кобзар',
      author: 'Тарас Шевченко',
      totalPages: 30,
      status: 'читається',
      rating: null,
    },
    records: [],
    onUpdate() {},
    onRate() {},
    onDeleteBook: (bookId) => deletions.push(bookId),
  };
  const { BookDetails } = require('../src/ui/BookDetails.js');
  const element = React.createElement(BookDetails, props);
  const tree = element.type(element.props);
  const button = findElement(tree, (candidate) =>
    candidate.type === 'button' && candidate.props['data-delete-book'] === 'book-a',
  );
  assert.ok(button, 'expected a delete-book button');

  const originalConfirm = global.confirm;
  let confirmationMessage;
  global.confirm = (message) => {
    confirmationMessage = message;
    return false;
  };
  try {
    button.props.onClick({ preventDefault() {} });
    assert.deepEqual(deletions, []);
    global.confirm = () => true;
    button.props.onClick({ preventDefault() {} });
  } finally {
    if (originalConfirm === undefined) {
      delete global.confirm;
    } else {
      global.confirm = originalConfirm;
    }
  }
  assert.equal(confirmationMessage, 'Ви хочете видалити цю книгу');
  assert.deepEqual(deletions, ['book-a']);
});
