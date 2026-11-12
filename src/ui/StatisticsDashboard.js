'use strict';

const React = require('react');
const { getDateInKyiv } = require('../time/kyiv-date.js');

function StatisticsDashboard({
  statistics,
  selectedPeriod = 'week',
  selectedDate = getDateInKyiv(),
  onPeriodChange,
  error = false,
}) {
  function submitPeriod(event) {
    event.preventDefault();
    const { period, date } = event.currentTarget.elements;
    onPeriodChange({ period: period.value, date: date.value });
  }

  return React.createElement(
    'section',
    { className: 'statistics-dashboard' },
    React.createElement('h1', null, 'Статистика'),
    React.createElement(
      'form',
      { 'data-form': 'statistics-period', onSubmit: submitPeriod },
      React.createElement(
        'label',
        null,
        'Період',
        React.createElement(
          'select',
          { name: 'period', defaultValue: selectedPeriod },
          React.createElement('option', { value: 'week' }, 'Тиждень'),
          React.createElement('option', { value: 'month' }, 'Місяць'),
          React.createElement('option', { value: 'year' }, 'Рік'),
        ),
      ),
      React.createElement(
        'label',
        null,
        'Опорна дата',
        React.createElement('input', {
          name: 'date',
          type: 'date',
          defaultValue: selectedDate,
          required: true,
        }),
      ),
      React.createElement('button', { type: 'submit' }, 'Показати'),
    ),
    error
      ? React.createElement('p', { role: 'alert' }, 'Помилка')
      : statistics
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(
              'p',
              null,
              `Період: ${statistics.period.startDate} — ${statistics.period.endDate}`,
            ),
            statistics.hasData
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(
                    'p',
                    null,
                    `Середнє за день: ${statistics.averagePagesPerDay} сторінок`,
                  ),
                  React.createElement(
                    'p',
                    null,
                    `Днів у періоді: ${statistics.daysCounted}`,
                  ),
                  React.createElement(
                    'p',
                    null,
                    `Усього прочитано: ${statistics.pagesReadTotal} сторінок`,
                  ),
                )
              : React.createElement('p', null, statistics.message),
          )
        : null,
  );
}

module.exports = { StatisticsDashboard };
