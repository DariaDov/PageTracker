'use strict';

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
