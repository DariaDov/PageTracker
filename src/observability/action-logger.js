'use strict';

/**
 * @fileoverview Structured action-event logger for application requests.
 */

/**
 * Creates a logger that writes one JSON record per action event.
 *
 * The default writer emits to stdout. Inject `writeLine` to route events
 * elsewhere; each event must include action, method, path, integer status, and
 * outcome. Actor IDs default to null.
 *
 * @param {object} [options] Logger configuration.
 * @param {(line: string) => void} [options.writeLine] Destination for each
 *   serialized event.
 * @returns {{logAction: (event: object) => void}} Logger interface.
 * @throws {TypeError} If the writer is not a function or an event is missing
 *   required fields.
 */
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
