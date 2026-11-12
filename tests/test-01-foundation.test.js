'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

test('REQ-NF-003: password hashes are not plaintext and can be verified', async () => {
  const { hashPassword, verifyPassword } = require('../src/security/password-hasher.js');
  const password = 'correct horse battery staple';
  const passwordHash = await hashPassword(password);

  assert.notEqual(passwordHash, password);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword('wrong password', passwordHash), false);
});

test('REQ-NF-006: failed work rolls back and releases its database connection', async () => {
  const { withTransaction } = require('../src/infrastructure/transaction.js');
  const statements = [];
  let released = false;
  const client = {
    async query(statement) {
      statements.push(statement);
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  const failure = new Error('forced transaction failure');

  await assert.rejects(
    withTransaction(pool, async () => {
      throw failure;
    }),
    failure,
  );

  assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
  assert.equal(released, true);
});

test('Europe/Kyiv date conversion handles the UTC date boundary', () => {
  const { getDateInKyiv } = require('../src/time/kyiv-date.js');

  assert.equal(getDateInKyiv(new Date('2026-11-12T22:30:00.000Z')), '2026-11-13');
});

test(
  'REQ-NF-004 / REQ-NF-007: PostgreSQL data persists across store instances at planned capacity',
  { skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to run PostgreSQL acceptance tests.' },
  async () => {
    const { createPostgresStore } = require('../src/infrastructure/postgres-store.js');
    const email = `test-${randomUUID()}@example.test`;
    const store = await createPostgresStore({ connectionString: process.env.TEST_DATABASE_URL });
    let userId;

    try {
      await store.migrate();
      const { hashPassword } = require('../src/security/password-hasher.js');
      const passwordHash = await hashPassword('test-only-password');

      await store.transaction(async (repositories) => {
        const user = await repositories.users.create({ email, passwordHash });
        userId = user.id;

        for (let bookIndex = 0; bookIndex < 100; bookIndex += 1) {
          const book = await repositories.books.create({
            userId,
            title: `Book ${bookIndex}`,
            author: 'Test Author',
            totalPages: 100,
          });

          for (let recordIndex = 0; recordIndex < 50; recordIndex += 1) {
            const startPage = recordIndex * 2 + 1;
            await repositories.readingRecords.create({
              bookId: book.id,
              startPage,
              endPage: startPage + 1,
              date: '2026-11-12',
            });
          }
        }
      });

      await store.close();
      const reopenedStore = await createPostgresStore({ connectionString: process.env.TEST_DATABASE_URL });

      try {
        const user = await reopenedStore.users.findByEmail(email);
        assert.ok(user);
        assert.notEqual(user.passwordHash, 'test-only-password');

        const books = await reopenedStore.books.listByUser(user.id);
        assert.equal(books.length, 100);

        const records = await reopenedStore.readingRecords.listByUser(user.id);
        assert.equal(records.length, 5000);
      } finally {
        if (userId) {
          await reopenedStore.users.deleteById(userId);
        }
        await reopenedStore.close();
      }
    } finally {
      if (!userId) {
        await store.close();
      }
    }
  },
);

test('REQ-NF-006: a failed database transaction leaves no partial book data', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to run PostgreSQL acceptance tests.',
}, async () => {
  const { createPostgresStore } = require('../src/infrastructure/postgres-store.js');
  const email = `rollback-${randomUUID()}@example.test`;
  const store = await createPostgresStore({ connectionString: process.env.TEST_DATABASE_URL });

  try {
    await store.migrate();
    const user = await store.users.create({ email, passwordHash: 'test-hash' });
    const failure = new Error('forced transaction failure');

    await assert.rejects(
      store.transaction(async (repositories) => {
        await repositories.books.create({
          userId: user.id,
          title: 'Must roll back',
          author: 'Test Author',
          totalPages: 1,
        });
        throw failure;
      }),
      failure,
    );

    assert.deepEqual(await store.books.listByUser(user.id), []);
  } finally {
    const user = await store.users.findByEmail(email);
    if (user) {
      await store.users.deleteById(user.id);
    }
    await store.close();
  }
});

test('Action logging: structured events exclude credentials and session secrets', () => {
  const { createActionLogger } = require('../src/observability/action-logger.js');
  const lines = [];
  const logger = createActionLogger({ writeLine: (line) => lines.push(line) });

  logger.logAction({
    action: 'book.create',
    actorId: 'user-1',
    method: 'POST',
    path: '/api/books',
    status: 201,
    outcome: 'success',
  });

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.action, 'book.create');
  assert.equal(event.actorId, 'user-1');
  assert.equal(event.method, 'POST');
  assert.equal(event.path, '/api/books');
  assert.equal(event.status, 201);
  assert.equal(event.outcome, 'success');
  assert.equal(typeof event.timestamp, 'string');
  assert.equal(lines[0].includes('password'), false);
  assert.equal(lines[0].includes('session'), false);
});
