'use strict';

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
