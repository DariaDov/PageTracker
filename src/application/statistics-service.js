'use strict';

/**
 * @fileoverview Calendar-period resolution and reading-statistics calculation.
 */

const EMPTY_STATISTICS_MESSAGE = 'Щоб побачити статистику, додайте новий запис';

/**
 * Indicates an invalid date or unsupported statistics period.
 */
class StatisticsQueryError extends Error {}

function parseCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new StatisticsQueryError('Дата має бути коректною календарною датою');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new StatisticsQueryError('Дата має бути коректною календарною датою');
  }
  return date;
}

function formatCalendarDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateAtUTC(year, month, day) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date;
}

function shiftCalendarDate(date, days) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return formatCalendarDate(shifted);
}

function getPeriodBounds(period, referenceDate) {
  const date = parseCalendarDate(referenceDate);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (period === 'week') {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    return {
      startDate: shiftCalendarDate(referenceDate, -daysSinceMonday),
      endDate: shiftCalendarDate(referenceDate, 6 - daysSinceMonday),
    };
  }
  if (period === 'month') {
    return {
      startDate: formatCalendarDate(dateAtUTC(year, month, 1)),
      endDate: formatCalendarDate(dateAtUTC(year, month + 1, 0)),
    };
  }
  return {
    startDate: formatCalendarDate(dateAtUTC(year, 0, 1)),
    endDate: formatCalendarDate(dateAtUTC(year, 11, 31)),
  };
}

/**
 * Resolves an ISO calendar date and period into inclusive date bounds.
 *
 * Weeks start on Monday. Omitted period defaults to `week`; omitted reference
 * date defaults to `today`. A period starting after today is rejected.
 *
 * @param {object} options Query selection.
 * @param {'week'|'month'|'year'} [options.period='week'] Period to resolve.
 * @param {string} [options.date] Reference date in YYYY-MM-DD form.
 * @param {string} options.today Current date in YYYY-MM-DD form.
 * @returns {{type: 'week'|'month'|'year', startDate: string, endDate: string}}
 *   Inclusive calendar bounds in YYYY-MM-DD form.
 * @throws {StatisticsQueryError} If a period is unsupported, either date is
 *   invalid, or the selected period is in the future.
 */
function resolveStatisticsPeriod({ period, date, today }) {
  const selectedPeriod = period ?? 'week';
  if (!['week', 'month', 'year'].includes(selectedPeriod)) {
    throw new StatisticsQueryError('Період має бути week, month або year');
  }
  parseCalendarDate(today);
  const referenceDate = date ?? today;
  parseCalendarDate(referenceDate);
  const bounds = getPeriodBounds(selectedPeriod, referenceDate);
  if (bounds.startDate > today) {
    throw new StatisticsQueryError('Майбутній період недоступний');
  }
  return { type: selectedPeriod, ...bounds };
}

/**
 * Calculates totals and the rounded daily average for a resolved period.
 *
 * Records outside the period or later than today are ignored. Days counted
 * runs from the period start through the earlier of its end and today, so
 * incomplete current periods do not include future days in the average.
 *
 * @param {Array<{date: string, pagesRead: number}>} records Reading records.
 * @param {{type: string, startDate: string, endDate: string}} period Resolved
 *   inclusive period bounds.
 * @param {string} today Current date in YYYY-MM-DD form.
 * @returns {{period: object, daysCounted: number, pagesReadTotal: number,
 *   hasData: boolean, averagePagesPerDay: number|null, message?: string}}
 *   Summary; average is null and message is set when no records match.
 */
function calculateStatistics(records, period, today) {
  const elapsedEndDate = period.endDate < today ? period.endDate : today;
  const daysCounted =
    Math.floor(
      (parseCalendarDate(elapsedEndDate) - parseCalendarDate(period.startDate)) / 86_400_000,
    ) + 1;
  const matchingRecords = records.filter(
    (record) =>
      record.date >= period.startDate &&
      record.date <= period.endDate &&
      record.date <= today,
  );
  const pagesReadTotal = matchingRecords.reduce((sum, record) => sum + record.pagesRead, 0);
  const hasData = matchingRecords.length > 0;

  return {
    period,
    daysCounted,
    pagesReadTotal,
    hasData,
    averagePagesPerDay: hasData ? Math.floor(pagesReadTotal / daysCounted + 0.5) : null,
    ...(hasData ? {} : { message: EMPTY_STATISTICS_MESSAGE }),
  };
}

module.exports = {
  StatisticsQueryError,
  calculateStatistics,
  resolveStatisticsPeriod,
};
