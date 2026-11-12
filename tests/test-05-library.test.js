'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function createMemoryStore({ failBookCreate = false } = {}) {
  const users = [
    { id: 'user-a', email: 'a@example.test' },
    { id: 'user-b', email: 'b@example.test' },
  ];
  const sessions = new Map([
    [createHash('sha256').update('session-a').digest('hex'), { userId: 'user-a' }],
    [createHash('sha256').update('session-b').digest('hex'), { userId: 'user-b' }],
  ]);
  const books = [];
  let bookCreateCalls = 0;

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
      async create(book) {
        bookCreateCalls += 1;
        if (failBookCreate) {
          throw new Error('simulated storage failure');
        }
        const created = {
          id: randomUUID(),
          ...book,
          status: 'розпочати',
          rating: null,
        };
        books.push(created);
        return created;
      },
      async listByUser(userId) {
        return books.filter((book) => book.userId === userId);
      },
    },
    seedBook(book) {
      books.push(book);
    },
    bookRows: books,
    bookCreateCalls: () => bookCreateCalls,
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

function createBook(id, userId, index) {
  return {
    id,
    userId,
    title: `Книга ${index}`,
    author: `Автор ${index}`,
    totalPages: 100 + index,
    status: 'розпочати',
    rating: null,
  };
}

test('TEST-05 / REQ-F-002, REQ-F-004, REQ-I-010, REQ-I-011: creating a book sets the approved initial state', async (t) => {
  const { baseUrl, store, logger } = await startApi(t);
  const response = await requestJson(baseUrl, '/books', 'POST', {
    title: 'Кобзар',
    author: 'Тарас Шевченко',
    totalPages: 240,
  });

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.data.title, 'Кобзар');
  assert.equal(result.data.author, 'Тарас Шевченко');
  assert.equal(result.data.totalPages, 240);
  assert.equal(result.data.status, 'розпочати');
  assert.equal(result.data.rating, null);
  assert.deepEqual(
    Object.keys(result.data).sort(),
    ['author', 'id', 'rating', 'status', 'title', 'totalPages'],
  );
  assert.equal(store.bookRows.length, 1);
  assert.deepEqual(logger.events.at(-1), {
    action: 'books.create',
    actorId: 'user-a',
    method: 'POST',
    path: '/api/books',
    status: 201,
    outcome: 'success',
  });
});

test('TEST-05 / REQ-F-001: creating a book requires an authenticated session', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const response = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Книга', author: 'Автор', totalPages: 1 }),
  });

  await assertProblem(response, 401, 'AUTH_REQUIRED');
  assert.equal(store.bookRows.length, 0);
  assert.equal(store.bookCreateCalls(), 0);
});

test('TEST-05 / REQ-F-024, REQ-F-026, REQ-F-027: invalid book fields are rejected without persistence', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const invalidBooks = [
    { author: 'Автор', totalPages: 1 },
    { title: 'Книга', totalPages: 1 },
    { title: '   ', author: 'Автор', totalPages: 1 },
    { title: 'Книга', author: '   ', totalPages: 1 },
    { title: 'Книга', author: 'Автор', totalPages: 0 },
    { title: 'Книга', author: 'Автор', totalPages: -1 },
    { title: 'Книга', author: 'Автор', totalPages: 1.5 },
    { title: 'Книга', author: 'Автор', totalPages: '10' },
  ];

  for (const book of invalidBooks) {
    await assertProblem(
      await requestJson(baseUrl, '/books', 'POST', book),
      422,
      'VALIDATION_ERROR',
    );
    assert.equal(store.bookRows.length, 0);
    assert.equal(store.bookCreateCalls(), 0);
  }
});

test('TEST-05 / API-CL-05, API-CL-09: malformed JSON and unknown fields do not create a book', async (t) => {
  const { baseUrl, store } = await startApi(t);
  const malformed = await fetch(`${baseUrl}/books`, {
    method: 'POST',
    headers: { cookie: 'pt_session=session-a', 'content-type': 'application/json' },
    body: '{"title":',
  });
  await assertProblem(malformed, 400, 'INVALID_JSON');

  await assertProblem(
    await requestJson(baseUrl, '/books', 'POST', {
      title: 'Книга',
      author: 'Автор',
      totalPages: 1,
      userId: 'user-b',
    }),
    400,
    'INVALID_PARAMETER',
  );
  assert.equal(store.bookRows.length, 0);
  assert.equal(store.bookCreateCalls(), 0);
});

test('TEST-05 / OpenAPI 500: storage failure returns a safe problem without partial book data', async (t) => {
  const store = createMemoryStore({ failBookCreate: true });
  const { baseUrl, logger } = await startApi(t, store);
  const response = await requestJson(baseUrl, '/books', 'POST', {
    title: 'Книга',
    author: 'Автор',
    totalPages: 1,
  });

  const problem = await assertProblem(response, 500, 'INTERNAL_ERROR');
  assert.equal(problem.detail, 'Помилка');
  assert.equal(store.bookRows.length, 0);
  assert.equal(store.bookCreateCalls(), 1);
  assert.equal(logger.events.at(-1).outcome, 'failure');
});

test('TEST-05 / REQ-F-001, REQ-I-004, REQ-I-015, REQ-I-016: library pages contain only the owner books and have size 16', async (t) => {
  const { baseUrl, store } = await startApi(t);
  for (let index = 1; index <= 17; index += 1) {
    store.seedBook(createBook(`a-${index}`, 'user-a', index));
  }
  store.seedBook(createBook('b-1', 'user-b', 1));

  const firstPage = await requestJson(baseUrl, '/books?page=1', 'GET');
  assert.equal(firstPage.status, 200);
  const firstResult = await firstPage.json();
  assert.equal(firstResult.data.length, 16);
  assert.ok(firstResult.data.every((book) => book.id.startsWith('a-')));
  assert.deepEqual(firstResult.pagination, {
    page: 1,
    pageSize: 16,
    totalItems: 17,
    totalPages: 2,
  });

  const secondPage = await requestJson(baseUrl, '/books?page=2', 'GET');
  assert.equal(secondPage.status, 200);
  const secondResult = await secondPage.json();
  assert.equal(secondResult.data.length, 1);
  assert.equal(secondResult.data[0].id, 'a-17');
  assert.deepEqual(secondResult.pagination, {
    page: 2,
    pageSize: 16,
    totalItems: 17,
    totalPages: 2,
  });
});

test('TEST-05 / API pagination: non-positive and non-integer page values return 400', async (t) => {
  const { baseUrl } = await startApi(t);
  for (const page of ['0', '-1', '1.5', 'invalid']) {
    await assertProblem(
      await requestJson(baseUrl, `/books?page=${encodeURIComponent(page)}`, 'GET'),
      400,
      'INVALID_PARAMETER',
    );
  }
});

function findElement(node, predicate) {
  if (!React.isValidElement(node)) {
    return null;
  }
  if (predicate(node)) {
    return node;
  }

  const children = React.Children.toArray(node.props.children);
  for (const child of children) {
    const result = findElement(child, predicate);
    if (result) {
      return result;
    }
  }
  return null;
}

function renderLibrary(props) {
  const { BookLibrary } = require('../src/ui/BookLibrary.js');
  const element = React.createElement(BookLibrary, props);
  return { element, markup: renderToStaticMarkup(element) };
}

test('TEST-05 / REQ-I-010: library renders a Ukrainian book creation form', () => {
  const { markup } = renderLibrary({
    books: [],
    pagination: { page: 1, pageSize: 16, totalItems: 0, totalPages: 0 },
    onCreate() {},
    onPageChange() {},
  });

  assert.match(markup, /<form\b/);
  assert.match(markup, /Назва книги/);
  assert.match(markup, /Автор/);
  assert.match(markup, /Кількість сторінок/);
  assert.match(markup, /Додати книгу/);
});

test('TEST-05 / REQ-I-004: library renders book metadata and available rating', () => {
  const { markup } = renderLibrary({
    books: [
      {
        id: 'book-1',
        title: 'Кобзар',
        author: 'Тарас Шевченко',
        totalPages: 240,
        status: 'прочитано',
        rating: 5,
      },
    ],
    pagination: { page: 1, pageSize: 16, totalItems: 1, totalPages: 1 },
    onCreate() {},
    onPageChange() {},
  });

  assert.match(markup, /Кобзар/);
  assert.match(markup, /Тарас Шевченко/);
  assert.match(markup, /прочитано/);
  assert.match(markup, /240/);
  assert.match(markup, /5/);
});

test('TEST-05 / REQ-I-016: numbered page controls call the approved page callback', () => {
  const selectedPages = [];
  const props = {
    books: [],
    pagination: { page: 1, pageSize: 16, totalItems: 17, totalPages: 2 },
    onCreate() {},
    onPageChange(page) {
      selectedPages.push(page);
    },
  };
  const { element, markup } = renderLibrary(props);
  assert.match(markup, />1<\/button>/);
  assert.match(markup, />2<\/button>/);

  const secondPageControl = findElement(
    element.type(element.props),
    (candidate) => candidate.type === 'button' && String(candidate.props.children) === '2',
  );
  assert.ok(secondPageControl, 'expected a button for page 2');
  secondPageControl.props.onClick();
  assert.deepEqual(selectedPages, [2]);
});

test('TEST-05 / REQ-I-010: submitting the form calls the create callback with parsed book data', () => {
  const createdBooks = [];
  const props = {
    books: [],
    pagination: { page: 1, pageSize: 16, totalItems: 0, totalPages: 0 },
    onCreate(book) {
      createdBooks.push(book);
    },
    onPageChange() {},
  };
  const { element } = renderLibrary(props);
  const form = findElement(
    element.type(element.props),
    (candidate) => candidate.type === 'form',
  );
  assert.ok(form, 'expected a book creation form');
  let preventedDefault = false;
  form.props.onSubmit({
    preventDefault() {
      preventedDefault = true;
    },
    currentTarget: {
      elements: {
        title: { value: 'Кобзар' },
        author: { value: 'Тарас Шевченко' },
        totalPages: { value: '240' },
      },
    },
  });

  assert.equal(preventedDefault, true);
  assert.deepEqual(createdBooks, [{
    title: 'Кобзар',
    author: 'Тарас Шевченко',
    totalPages: 240,
  }]);
});
