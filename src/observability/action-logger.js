'use strict';

function createActionLogger({ writeLine = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (typeof writeLine !== 'function') {
    throw new TypeError('writeLine must be a function');
  }

  return {
    logAction({ action, actorId = null, method, path, status, outcome }) {
      if (
        typeof action !== 'string' ||
        typeof method !== 'string' ||
        typeof path !== 'string' ||
        !Number.isInteger(status) ||
        typeof outcome !== 'string'
      ) {
        throw new TypeError('Action log event is missing required fields');
      }

      const event = {
        timestamp: new Date().toISOString(),
        action,
        actorId,
        method,
        path,
        status,
        outcome,
      };

      writeLine(JSON.stringify(event));
    },
  };
}

module.exports = { createActionLogger };
