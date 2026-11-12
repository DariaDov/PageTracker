'use strict';

const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { withTransaction } = require('./transaction.js');

const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS books (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    author text NOT NULL,
    total_pages integer NOT NULL CHECK (total_pages >= 1),
    status text NOT NULL DEFAULT 'розпочати'
      CHECK (status IN ('розпочати', 'читається', 'прочитано')),
    rating integer CHECK (rating BETWEEN 1 AND 5),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS reading_records (
    id uuid PRIMARY KEY,
    book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    start_page integer NOT NULL CHECK (start_page >= 1),
    end_page integer NOT NULL CHECK (end_page >= start_page),
    pages_read integer NOT NULL CHECK (pages_read = end_page - start_page + 1),
    date date NOT NULL
  );

  CREATE INDEX IF NOT EXISTS books_user_id_idx ON books(user_id);
  CREATE INDEX IF NOT EXISTS reading_records_book_id_date_idx
    ON reading_records(book_id, date, start_page);
`;

function mapUser(row) {
  if (!row) {
    return null;
  }
  return { id: row.id, email: row.email, passwordHash: row.password_hash };
}

function mapBook(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    author: row.author,
    totalPages: row.total_pages,
    status: row.status,
    rating: row.rating,
  };
}

function mapReadingRecord(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    startPage: row.start_page,
    endPage: row.end_page,
    pagesRead: row.pages_read,
    date: row.date,
  };
}

function createRepositories(queryable) {
  return {
    users: {
      async create({ email, passwordHash }) {
        const { rows } = await queryable.query(
          `INSERT INTO users (id, email, password_hash)
           VALUES ($1, $2, $3)
           RETURNING id, email, password_hash`,
          [randomUUID(), email, passwordHash],
        );
        return mapUser(rows[0]);
      },
      async findByEmail(email) {
        const { rows } = await queryable.query(
          'SELECT id, email, password_hash FROM users WHERE email = $1',
          [email],
        );
        return mapUser(rows[0]);
      },
      async findById(id) {
        const { rows } = await queryable.query(
          'SELECT id, email, password_hash FROM users WHERE id = $1',
          [id],
        );
        return mapUser(rows[0]);
      },
      async deleteById(id) {
        await queryable.query('DELETE FROM users WHERE id = $1', [id]);
      },
    },
    sessions: {
      async create({ userId, tokenHash }) {
        await queryable.query(
          'INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)',
          [tokenHash, userId],
        );
      },
      async findByTokenHash(tokenHash) {
        const { rows } = await queryable.query(
          'SELECT token_hash, user_id FROM sessions WHERE token_hash = $1',
          [tokenHash],
        );
        return rows[0] ? { tokenHash: rows[0].token_hash, userId: rows[0].user_id } : null;
      },
      async deleteByTokenHash(tokenHash) {
        await queryable.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      },
    },
    books: {
      async create({ userId, title, author, totalPages }) {
        const { rows } = await queryable.query(
          `INSERT INTO books (id, user_id, title, author, total_pages)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, user_id, title, author, total_pages, status, rating`,
          [randomUUID(), userId, title, author, totalPages],
        );
        return mapBook(rows[0]);
      },
      async listByUser(userId) {
        const { rows } = await queryable.query(
          `SELECT id, user_id, title, author, total_pages, status, rating
           FROM books
           WHERE user_id = $1
           ORDER BY created_at, id`,
          [userId],
        );
        return rows.map(mapBook);
      },
      async findByIdForUser(bookId, userId) {
        const { rows } = await queryable.query(
          `SELECT id, user_id, title, author, total_pages, status, rating
           FROM books
           WHERE id = $1 AND user_id = $2`,
          [bookId, userId],
        );
        return rows[0] ? mapBook(rows[0]) : null;
      },
    },
    readingRecords: {
      async create({ bookId, startPage, endPage, date }) {
        const { rows } = await queryable.query(
          `INSERT INTO reading_records (id, book_id, start_page, end_page, pages_read, date)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, book_id, start_page, end_page, pages_read, date`,
          [randomUUID(), bookId, startPage, endPage, endPage - startPage + 1, date],
        );
        return mapReadingRecord(rows[0]);
      },
      async listByUser(userId) {
        const { rows } = await queryable.query(
          `SELECT r.id, r.book_id, r.start_page, r.end_page, r.pages_read, r.date
           FROM reading_records AS r
           JOIN books AS b ON b.id = r.book_id
           WHERE b.user_id = $1
           ORDER BY r.date, r.start_page, r.id`,
          [userId],
        );
        return rows.map(mapReadingRecord);
      },
    },
  };
}

async function createPostgresStore({ connectionString } = {}) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new TypeError('A PostgreSQL connection string is required');
  }

  const pool = new Pool({ connectionString });
  const repositories = createRepositories(pool);

  return {
    async migrate() {
      await pool.query(MIGRATIONS);
    },
    async transaction(operation) {
      if (typeof operation !== 'function') {
        throw new TypeError('Transaction operation must be a function');
      }
      return withTransaction(pool, (client) => operation(createRepositories(client)));
    },
    ...repositories,
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPostgresStore };
