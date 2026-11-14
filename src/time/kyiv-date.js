'use strict';

/**
 * @fileoverview Calendar-date formatting in the Europe/Kyiv timezone.
 */

const kyivDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Formats an instant as a calendar date in Europe/Kyiv.
 *
 * @param {Date} [date=new Date()] Instant to format.
 * @returns {string} Date in YYYY-MM-DD form.
 * @throws {TypeError} If date is not a valid Date instance.
 */
function getDateInKyiv(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('A valid Date instance is required');
  }

  const parts = kyivDateFormatter.formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

module.exports = { getDateInKyiv };
