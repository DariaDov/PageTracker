'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function createMemoryStore({ failUpdate = false } = {}) {
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
      id: 'book-b',
      userId: 'user-b',
      title: 'Інша книга',
      author: 'Інший автор',
      totalPages: 100,
      status: 'прочитано',
      rating: 4,
    },
  ];
  const records = [];
  let updateCalls = 0;

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
      async updateForUser(bookId, userId, changes) {
        updateCalls += 1;
        if (failUpdate) {
          throw new Error('simulated storage failure');
        }
        const book = books.find((item) => item.id === bookId && item.userId === userId);
        if (!book) {
          return null;
        }
        Object.assign(book, changes);
        return book;
      },
    },
    readingRecords: {
      async listByUser(userId) {
        return records.filter((record) =>
          books.some((book) => book.id === record.bookId && book.userId === userId),
        );
      },
    },
    bookRows: books,
    records,
    updateCalls: () => updateCalls,
    seedRecord(record) {
      records.push(record);
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

async function requestJson(baseUrl, path, method, body, session = 'session-a') {
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

async function assertProblem(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/);
  const result = await response.json();
  assert.equal(result.status, status);
  assert.equal(result.code, code);
  return result;
}

test('TEST-06 / REQ-F-001, REQ-I-003: book details require a session and hide missing or foreign books', async (t) => {
  const { baseUrl } = await startApi(t);
  const details = await requestJson(baseUrl, '/books/book-a', 'GET');
  assert.equal(details.status, 200);
  const result = await details.json();
  assert.deepEqual(result.data, {
    id: 'book-a',
    title: 'Кобзар',
    author: 'Тарас Шевченко',
    totalPages: 240,
    status: 'розпочати',
    rating: null,
  });

  const unauthenticated = await fetch(`${baseUrl}/books/book-a`);
  await assertProblem(unauthenticated, 401, 'AUTH_REQUIRED');

  const foreign = await requestJson(baseUrl, '/books/book-b', 'GET');
  const missing = await requestJson(baseUrl, '/books/missing-book', 'GET');
  const foreignProblem = await assertProblem(foreign, 404, 'NOT_FOUND');
  const missingProblem = await assertProblem(missing, 404, 'NOT_FOUND');
  assert.equal(foreignProblem.detail, missingProblem.detail);
});

test('TEST-06 / REQ-F-028: title and author can be edited without changing server-managed status', async (t) => {
  const { baseUrl, store, logger } = await startApi(t);
  store.bookRows[0].status = 'читається';
  const response = await requestJson(baseUrl, '/books/book-a', 'PATCH', {
    title: 'Нове видання',
    author: 'Інший автор',
  });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.title, 'Нове видання');
  assert.equal(result.data.author, 'Інший автор');
  assert.equal(result.data.status, 'читається');
  assert.equal(result.data.totalPages, 240);
  assert.equal(logger.events.at(-1).action, 'books.update');
});

test('TEST-06 / REQ-F-013: total pages may change before the first reading record', async (t) => {
  const { baseUrl } = await startApi(t);
  const response = await requestJson(baseUrl, '/books/book-a', 'PATCH', { totalPages: 300 });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.totalPages, 300);
});

test('TEST-06 / REQ-F-013, API-CL-11: total pages cannot change after reading starts and no state is mutated', async (t) => {
  const { baseUrl, store } = await startApi(t);
  store.seedRecord({
    id: 'record-a',
    bookId: 'book-a',
    startPage: 1,
    endPage: 10,
    pagesRead: 10,
    date: '2026-11-12',
  });

  await assertProblem(
    await requestJson(baseUrl, '/books/book-a', 'PATCH', {
      title: 'Нова назва',
      totalPages: 300,
    }),
    409,
    'STATE_CONFLICT',
  );
  assert.equal(store.bookRows[0].title, 'Кобзар');
  assert.equal(store.bookRows[0].totalPages, 240);
  assert.equal(store.records.length, 1);
});

test('TEST-06 / REQ-F-005: completed books accept rating changes from one to five', async (t) => {
  const { baseUrl, store } = await startApi(t);
  Object.assign(store.bookRows[0], {
    status: 'прочитано',
    rating: null,
  });

  for (const rating of [1, 5]) {
    const response = await requestJson(baseUrl, '/books/book-a', 'PATCH', { rating });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.rating, rating);
  }
});

test('TEST-06 / REQ-F-005: unfinished books reject rating changes without mutation', async (t) => {
  const { baseUrl, store } = await startApi(t);
  await assertProblem(
    await requestJson(baseUrl, '/books/book-a', 'PATCH', { rating: 5 }),
    409,
    'STATE_CONFLICT',
  );
  assert.equal(store.bookRows[0].rating, null);
});

test('TEST-06 / REQ-F-042, OpenAPI BookPatch: invalid values and empty patches are rejected', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const invalidUpdates = [
    {},
    { title: '   ' },
    { author: '' },
    { totalPages: 0 },
    { totalPages: 1.5 },
    { rating: 0 },
    { rating: 6 },
    { rating: 2.5 },
  ];

  for (const update of invalidUpdates) {
    await assertProblem(
      await requestJson(baseUrl, '/books/book-a', 'PATCH', update),
      422,
      'VALIDATION_ERROR',
    );
    assert.equal(store.bookRows[0].title, 'Кобзар');
    assert.equal(store.bookRows[0].totalPages, 240);
    assert.equal(store.bookRows[0].rating, null);
  }
});

test('TEST-06 / API-CL-09: unknown and server-managed fields are rejected', async (t) => {
  const { baseUrl, store } = await startApi(t);
  for (const update of [{ status: 'прочитано' }, { userId: 'user-b' }, { title: 'Нова', extra: true }]) {
    await assertProblem(
      await requestJson(baseUrl, '/books/book-a', 'PATCH', update),
      400,
      'INVALID_PARAMETER',
    );
    assert.equal(store.bookRows[0].title, 'Кобзар');
    assert.equal(store.bookRows[0].status, 'розпочати');
  }
});

test('TEST-06 / REQ-F-001: patching a missing or foreign book returns the same 404', async (t) => {
  const { baseUrl } = await startApi(t);
  const foreign = await requestJson(baseUrl, '/books/book-b', 'PATCH', { title: 'Не змінювати' });
  const missing = await requestJson(baseUrl, '/books/missing-book', 'PATCH', { title: 'Немає' });
  const foreignProblem = await assertProblem(foreign, 404, 'NOT_FOUND');
  const missingProblem = await assertProblem(missing, 404, 'NOT_FOUND');
  assert.equal(foreignProblem.detail, missingProblem.detail);
});

test('TEST-06 / REQ-F-001: patching a book without a session returns 401 without mutation', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const response = await fetch(`${baseUrl}/books/book-a`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Неавторизована зміна' }),
  });

  await assertProblem(response, 401, 'AUTH_REQUIRED');
  assert.equal(store.bookRows[0].title, 'Кобзар');
});

test('TEST-06 / OpenAPI 500: update storage failure returns a safe problem without exposing input', async (t) => {
  const store = createMemoryStore({ failUpdate: true });
  const { baseUrl, logger } = await startApi(t, store);
  const response = await requestJson(baseUrl, '/books/book-a', 'PATCH', { title: 'Secret title' });
  const problem = await assertProblem(response, 500, 'INTERNAL_ERROR');

  assert.equal(problem.detail, 'Помилка');
  assert.equal(JSON.stringify(problem).includes('Secret title'), false);
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

function createDetailsProps(overrides = {}) {
  return {
    book: {
      id: 'book-a',
      title: 'Кобзар',
      author: 'Тарас Шевченко',
      totalPages: 240,
      status: 'розпочати',
      rating: null,
    },
    records: [
      { id: 'record-a', date: '2026-11-12', pagesRead: 10 },
    ],
    onUpdate() {},
    onRate() {},
    ...overrides,
  };
}

function renderDetails(props) {
  const { BookDetails } = require('../src/ui/BookDetails.js');
  const element = React.createElement(BookDetails, props);
  return { element, markup: renderToStaticMarkup(element) };
}

test('TEST-06 / REQ-I-003: details render book metadata, status, rating, and reading records', () => {
  const { markup } = renderDetails(createDetailsProps({
    book: {
      id: 'book-a',
      title: 'Кобзар',
      author: 'Тарас Шевченко',
      totalPages: 240,
      status: 'прочитано',
      rating: 5,
    },
  }));

  assert.match(markup, /Кобзар/);
  assert.match(markup, /Тарас Шевченко/);
  assert.match(markup, /прочитано/);
  assert.match(markup, /240/);
  assert.match(markup, /5/);
  assert.match(markup, /2026-11-12/);
  assert.match(markup, /10/);
});

test('TEST-06 / REQ-I-018: details edit form submits title and author through callback', () => {
  const updates = [];
  const props = createDetailsProps({ onUpdate: (changes) => updates.push(changes) });
  const { element } = renderDetails(props);
  const tree = element.type(element.props);
  const form = findElement(tree, (candidate) =>
    candidate.type === 'form' && candidate.props['data-form'] === 'metadata',
  );
  assert.ok(form, 'expected a metadata edit form');
  form.props.onSubmit({
    preventDefault() {},
    currentTarget: {
      elements: {
        title: { value: 'Нова назва' },
        author: { value: 'Новий автор' },
      },
    },
  });
  assert.deepEqual(updates, [{ title: 'Нова назва', author: 'Новий автор' }]);
});

test('TEST-06 / REQ-F-013: page count edit submits the changed value through callback', () => {
  const updates = [];
  const { element } = renderDetails(createDetailsProps({
    records: [],
    onUpdate: (changes) => updates.push(changes),
  }));
  const form = findElement(element.type(element.props), (candidate) =>
    candidate.type === 'form' && candidate.props['data-form'] === 'page-count',
  );
  assert.ok(form, 'expected a page-count edit form');
  form.props.onSubmit({
    preventDefault() {},
    currentTarget: { elements: { totalPages: { value: '300' } } },
  });
  assert.deepEqual(updates, [{ totalPages: 300 }]);
});

test('TEST-06 / REQ-F-013: page count can be edited only before reading starts', () => {
  const noRecords = renderDetails(createDetailsProps({ records: [] }));
  const noRecordsTree = noRecords.element.type(noRecords.element.props);
  assert.ok(findElement(noRecordsTree, (candidate) =>
    candidate.type === 'input' && candidate.props.name === 'totalPages',
  ));

  const withRecords = renderDetails(createDetailsProps());
  const withRecordsTree = withRecords.element.type(withRecords.element.props);
  assert.equal(findElement(withRecordsTree, (candidate) =>
    candidate.type === 'input' && candidate.props.name === 'totalPages',
  ), null);
});

test('TEST-06 / REQ-F-005: rating control is available only for completed books', () => {
  const completed = renderDetails(createDetailsProps({
    book: {
      id: 'book-a',
      title: 'Кобзар',
      author: 'Тарас Шевченко',
      totalPages: 240,
      status: 'прочитано',
      rating: null,
    },
  }));
  const completedTree = completed.element.type(completed.element.props);
  assert.ok(findElement(completedTree, (candidate) =>
    candidate.type === 'select' && candidate.props.name === 'rating',
  ));

  const unfinished = renderDetails(createDetailsProps());
  const unfinishedTree = unfinished.element.type(unfinished.element.props);
  assert.equal(findElement(unfinishedTree, (candidate) =>
    candidate.type === 'select' && candidate.props.name === 'rating',
  ), null);
});

test('TEST-06 / REQ-F-005: completed-book rating selection calls the rating callback', () => {
  const ratings = [];
  const { element } = renderDetails(createDetailsProps({
    book: {
      id: 'book-a',
      title: 'Кобзар',
      author: 'Тарас Шевченко',
      totalPages: 240,
      status: 'прочитано',
      rating: null,
    },
    onRate: (rating) => ratings.push(rating),
  }));
  const ratingSelect = findElement(element.type(element.props), (candidate) =>
    candidate.type === 'select' && candidate.props.name === 'rating',
  );
  assert.ok(ratingSelect, 'expected a completed-book rating control');
  ratingSelect.props.onChange({ currentTarget: { value: '5' } });
  assert.deepEqual(ratings, [5]);
});
