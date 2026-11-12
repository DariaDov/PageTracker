'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function createMemoryStore({ failRecordUpdate = false, failRecordDelete = false } = {}) {
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
      totalPages: 30,
      status: 'прочитано',
      rating: 5,
    },
  ];
  const records = [];

  function getOwnedRecord(recordId, userId) {
    const record = records.find((item) => item.id === recordId);
    if (!record) {
      return null;
    }
    return books.some((book) => book.id === record.bookId && book.userId === userId)
      ? record
      : null;
  }

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
      async findByIdForUser(recordId, userId) {
        return getOwnedRecord(recordId, userId);
      },
      async updateForUser(recordId, userId, changes) {
        if (failRecordUpdate) {
          throw new Error('simulated record update failure');
        }
        const record = getOwnedRecord(recordId, userId);
        if (!record) {
          return null;
        }
        const nextValues = { ...record, ...changes };
        Object.assign(record, nextValues, {
          pagesRead: nextValues.endPage - nextValues.startPage + 1,
        });
        return record;
      },
      async deleteForUser(recordId, userId) {
        if (failRecordDelete) {
          throw new Error('simulated record delete failure');
        }
        const record = getOwnedRecord(recordId, userId);
        if (!record) {
          return null;
        }
        records.splice(records.indexOf(record), 1);
        return record;
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
        id,
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

async function request(baseUrl, path, method, body, session = 'session-a') {
  const headers = { cookie: `pt_session=${session}` };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

test('TEST-09 / REQ-I-006: reading records are listed by date and start page with only date and page count', async (t) => {
  const { baseUrl, store, logger } = await startApi(t);
  store.seedRecord({ id: 'record-late', startPage: 11, endPage: 20, date: '2026-11-13' });
  store.seedRecord({ id: 'record-second', startPage: 11, endPage: 15, date: '2026-11-12' });
  store.seedRecord({ id: 'record-first', startPage: 1, endPage: 10, date: '2026-11-12' });

  const response = await request(baseUrl, '/books/book-a/reading-records', 'GET');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data.map((record) => record.id), [
    'record-first',
    'record-second',
    'record-late',
  ]);
  assert.deepEqual(Object.keys(result.data[0]).sort(), [
    'bookId',
    'date',
    'endPage',
    'id',
    'pagesRead',
    'startPage',
  ]);
  assert.equal(logger.events.at(-1).action, 'reading-records.list');
});

test('TEST-09 / REQ-F-001: listing records requires the owner and hides foreign or missing books', async (t) => {
  const { baseUrl } = await startApi(t);
  await assertProblem(
    await fetch(`${baseUrl}/books/book-a/reading-records`),
    401,
    'AUTH_REQUIRED',
  );
  const foreign = await request(baseUrl, '/books/book-b/reading-records', 'GET');
  const missing = await request(baseUrl, '/books/missing/reading-records', 'GET');
  const foreignProblem = await assertProblem(foreign, 404, 'NOT_FOUND');
  const missingProblem = await assertProblem(missing, 404, 'NOT_FOUND');
  assert.equal(foreignProblem.detail, missingProblem.detail);
});

test('TEST-09 / REQ-F-011, REQ-F-032: editing a reading record recalculates pages and completes the book at its final page', async (t) => {
  const { baseUrl, store, logger } = await startApi(t);
  store.bookRows[0].totalPages = 20;
  store.seedRecord({ id: 'record-a', startPage: 1, endPage: 10 });
  store.seedRecord({ id: 'record-b', startPage: 11, endPage: 15 });

  const response = await request(baseUrl, '/reading-records/record-b', 'PATCH', { endPage: 20 });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data, {
    id: 'record-b',
    bookId: 'book-a',
    startPage: 11,
    endPage: 20,
    pagesRead: 10,
    date: '2026-11-12',
  });
  assert.equal(store.bookRows[0].status, 'прочитано');
  assert.equal(logger.events.at(-1).action, 'reading-records.update');
});

test('TEST-09 / REQ-F-034, REQ-F-036: invalid record edits reject gaps, overlaps, and out-of-range pages without mutation', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.seedRecord({ id: 'record-a', startPage: 1, endPage: 10 });
  store.seedRecord({ id: 'record-b', startPage: 11, endPage: 20 });
  const original = store.recordRows.map((record) => ({ ...record }));

  await assertProblem(
    await request(baseUrl, '/reading-records/record-b', 'PATCH', { startPage: 12 }),
    409,
    'STATE_CONFLICT',
    'Відсутні сторінки',
  );
  await assertProblem(
    await request(baseUrl, '/reading-records/record-b', 'PATCH', { startPage: 10 }),
    409,
    'STATE_CONFLICT',
    'Ці сторінки вже прочитані',
  );
  await assertProblem(
    await request(baseUrl, '/reading-records/record-b', 'PATCH', { endPage: 31 }),
    422,
    'VALIDATION_ERROR',
    'Будь ласка, змініть сторінку',
  );
  assert.deepEqual(store.recordRows, original);
  assert.equal(store.bookRows[0].status, 'читається');
});

test('TEST-09 / REQ-F-011: only books currently being read may have records edited', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.seedRecord({ id: 'record-a', startPage: 1, endPage: 10, bookId: 'book-b' });
  const completed = await request(baseUrl, '/reading-records/record-a', 'PATCH', { endPage: 11 });
  await assertProblem(completed, 409, 'STATE_CONFLICT');
  assert.equal(store.recordRows[0].endPage, 10);
  assert.equal(store.bookRows[1].status, 'прочитано');
});

test('TEST-09 / REQ-F-031, REQ-F-037: deleting a middle record is rejected when it would leave a page gap', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.seedRecord({ id: 'record-first', startPage: 1, endPage: 10 });
  store.seedRecord({ id: 'record-middle', startPage: 11, endPage: 20 });
  store.seedRecord({ id: 'record-last', startPage: 21, endPage: 30 });

  await assertProblem(
    await request(baseUrl, '/reading-records/record-middle', 'DELETE'),
    409,
    'STATE_CONFLICT',
    'Видалення заборонене',
  );
  assert.deepEqual(store.recordRows.map((record) => record.id), [
    'record-first',
    'record-middle',
    'record-last',
  ]);
});

test('TEST-09 / REQ-F-033: deleting the sole record resets status; deleting the latest of several preserves reading status', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.seedRecord({ id: 'record-only', startPage: 1, endPage: 10 });

  const onlyDelete = await request(baseUrl, '/reading-records/record-only', 'DELETE');
  assert.equal(onlyDelete.status, 204);
  assert.equal(store.recordRows.length, 0);
  assert.equal(store.bookRows[0].status, 'розпочати');

  store.bookRows[0].status = 'читається';
  store.seedRecord({ id: 'record-first', startPage: 1, endPage: 10 });
  store.seedRecord({ id: 'record-last', startPage: 11, endPage: 20 });
  const lastDelete = await request(baseUrl, '/reading-records/record-last', 'DELETE');
  assert.equal(lastDelete.status, 204);
  assert.deepEqual(store.recordRows.map((record) => record.id), ['record-first']);
  assert.equal(store.bookRows[0].status, 'читається');
});

test('TEST-09 / REQ-F-006, REQ-F-031: completed books reject record edits and deletion without mutation', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.bookRows[0].status = 'прочитано';
  store.seedRecord({ id: 'record-a', startPage: 1, endPage: 30 });

  await assertProblem(
    await request(baseUrl, '/reading-records/record-a', 'PATCH', { endPage: 29 }),
    409,
    'STATE_CONFLICT',
  );
  await assertProblem(
    await request(baseUrl, '/reading-records/record-a', 'DELETE'),
    409,
    'STATE_CONFLICT',
  );
  assert.equal(store.recordRows[0].endPage, 30);
  assert.equal(store.bookRows[0].status, 'прочитано');
});

test('TEST-09 / REQ-NF-006: record storage failures roll back and return safe errors', async (t) => {
  for (const options of [{ failRecordUpdate: true }, { failRecordDelete: true }]) {
    const store = createMemoryStore(options);
    const { baseUrl, logger } = await startApi(t, store);
    store.seedRecord({ id: 'record-a', startPage: 1, endPage: 10 });

    const response = options.failRecordUpdate
      ? await request(baseUrl, '/reading-records/record-a', 'PATCH', { endPage: 15 })
      : await request(baseUrl, '/reading-records/record-a', 'DELETE');
    const problem = await assertProblem(response, 500, 'INTERNAL_ERROR');
    assert.equal(problem.detail, 'Помилка');
    assert.equal(store.recordRows.length, 1);
    assert.equal(store.recordRows[0].endPage, 10);
    assert.equal(store.bookRows[0].status, 'читається');
    assert.equal(logger.events.at(-1).outcome, 'failure');
  }
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

test('TEST-09 / REQ-I-006, REQ-I-013: book details sort records and provide edit and confirmed delete actions', () => {
  const updates = [];
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
    records: [
      { id: 'record-late', date: '2026-11-13', startPage: 11, endPage: 20, pagesRead: 10 },
      { id: 'record-first', date: '2026-11-12', startPage: 1, endPage: 10, pagesRead: 10 },
    ],
    onUpdate() {},
    onRate() {},
    onUpdateRecord: (recordId, changes) => updates.push({ recordId, changes }),
    onDeleteRecord: (recordId) => deletions.push(recordId),
  };
  const { BookDetails } = require('../src/ui/BookDetails.js');
  const element = React.createElement(BookDetails, props);
  const markup = renderToStaticMarkup(element);
  assert.ok(markup.indexOf('2026-11-12') < markup.indexOf('2026-11-13'));
  assert.equal(markup.includes('1–10'), false);

  const tree = element.type(element.props);
  const editForm = findElement(tree, (candidate) =>
    candidate.type === 'form' &&
    candidate.props['data-form'] === 'reading-record' &&
    candidate.props['data-record-id'] === 'record-first',
  );
  assert.ok(editForm, 'expected an edit form for each record');
  editForm.props.onSubmit({
    preventDefault() {},
    currentTarget: { elements: { startPage: { value: '1' }, endPage: { value: '12' } } },
  });
  assert.deepEqual(updates, [{ recordId: 'record-first', changes: { startPage: 1, endPage: 12 } }]);

  const deleteButton = findElement(tree, (candidate) =>
    candidate.type === 'button' && candidate.props['data-delete-record'] === 'record-first',
  );
  assert.ok(deleteButton, 'expected a delete button for each record');
  const originalConfirm = global.confirm;
  let confirmationMessage;
  global.confirm = (message) => {
    confirmationMessage = message;
    return true;
  };
  try {
    deleteButton.props.onClick({ preventDefault() {} });
  } finally {
    if (originalConfirm === undefined) {
      delete global.confirm;
    } else {
      global.confirm = originalConfirm;
    }
  }
  assert.equal(confirmationMessage, 'Ви хочете видалити цей запис');
  assert.deepEqual(deletions, ['record-first']);
});
