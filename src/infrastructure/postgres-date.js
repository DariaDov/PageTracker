'use strict';

/**
 * @fileoverview Converts PostgreSQL calendar dates without timezone drift.
 */

/**
 * Converts a node-postgres DATE value into its YYYY-MM-DD calendar form.
 *
 * Strings are returned unchanged. Date objects are formatted using local date
 * fields because node-postgres represents SQL DATE values as local midnight.
 *
 * @param {string|Date} value PostgreSQL DATE value.
 * @returns {string} Calendar date in YYYY-MM-DD form.
 * @throws {TypeError} If value is not a string or valid Date.
 */
function mapCalendarDate(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('Expected a valid PostgreSQL DATE value');
  }

  // node-postgres parses DATE as local midnight, so UTC conversion can shift the calendar day.
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = { mapCalendarDate };
