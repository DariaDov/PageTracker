'use strict';

/**
 * @fileoverview PostgreSQL transaction helper with guaranteed connection release.
 */

/**
 * Runs an operation on a dedicated PostgreSQL client inside a transaction.
 *
 * Commits on success and rolls back on operation or commit failure. The client
 * is always released; if rollback or release also fails, the original and
 * cleanup failures are surfaced together in an AggregateError.
 *
 * @template T
 * @param {{connect: () => Promise<{query: Function, release: Function}>}} pool
 *   Pool or compatible connection provider.
 * @param {(client: {query: Function}) => Promise<T>} operation Work to execute
 *   using the acquired client.
 * @returns {Promise<T>} The operation's result after a successful commit.
 * @throws {TypeError} If the pool or operation does not satisfy its contract.
 * @throws {Error|AggregateError} If the operation, transaction, or cleanup
 *   fails.
 */
async function withTransaction(pool, operation) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('Pool must provide a connect method');
  }
  if (typeof operation !== 'function') {
    throw new TypeError('Transaction operation must be a function');
  }

  const client = await pool.connect();
  let transactionStarted = false;
  let result;
  let failure;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    result = await operation(client);
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    failure = error;
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          'Transaction failed and rollback could not be completed',
        );
      }
    }
  } finally {
    try {
      client.release();
    } catch (releaseError) {
      failure = failure
        ? new AggregateError([failure, releaseError], 'Transaction failed and connection release failed')
        : releaseError;
    }
  }

  if (failure) {
    throw failure;
  }

  return result;
}

module.exports = { withTransaction };
