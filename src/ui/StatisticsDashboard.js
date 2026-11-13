'use strict';

const React = require('react');
const { getDateInKyiv } = require('../time/kyiv-date.js');

function StatisticsDashboard({
  statistics,
  selectedPeriod = 'week',
  selectedDate = getDateInKyiv(),
  onPeriodChange,
  readingGoals = { week: null, month: null },
  onGoalChange,
  onGoalDelete,
  error = false,
}) {
  function submitPeriod(event) {
    event.preventDefault();
    const { period, date } = event.currentTarget.elements;
    onPeriodChange({ period: period.value, date: date.value });
  }

  function submitGoal(event) {
    event.preventDefault();
    const { period, targetPages } = event.currentTarget.elements;
    if (typeof onGoalChange !== 'function') {
      throw new TypeError('onGoalChange must be a function');
    }
    onGoalChange({ period: period.value, targetPages: Number(targetPages.value) });
  }

  function deleteGoal(period) {
    if (typeof onGoalDelete !== 'function') {
      throw new TypeError('onGoalDelete must be a function');
    }
    onGoalDelete(period);
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
    React.createElement(
      'section',
      { className: 'reading-goals', 'aria-labelledby': 'reading-goals-heading' },
      React.createElement('h2', { id: 'reading-goals-heading' }, 'Цілі читання'),
      statistics?.goalProgress
        ? React.createElement(
            'div',
            { 'data-section': 'reading-goal-progress' },
            React.createElement(
              'h3',
              null,
              statistics.period.type === 'week' ? 'Ціль на тиждень' : 'Ціль на місяць',
            ),
            React.createElement(
              'p',
              null,
              `Прочитано: ${statistics.goalProgress.pagesRead} із ${statistics.goalProgress.targetPages} сторінок`,
            ),
            React.createElement(
              'p',
              null,
              `Залишилося: ${statistics.goalProgress.remainingPages} сторінок`,
            ),
            React.createElement(
              'p',
              null,
              `Виконано: ${statistics.goalProgress.percentage}%`,
            ),
            React.createElement(
              'p',
              null,
              statistics.goalProgress.achieved ? 'Ціль досягнуто' : 'Ціль ще не досягнуто',
            ),
          )
        : null,
      React.createElement(
        'form',
        { 'data-form': 'reading-goal', onSubmit: submitGoal },
        React.createElement(
          'label',
          null,
          'Період цілі',
          React.createElement(
            'select',
            { name: 'period', defaultValue: selectedPeriod === 'month' ? 'month' : 'week' },
            React.createElement('option', { value: 'week' }, 'Тиждень'),
            React.createElement('option', { value: 'month' }, 'Місяць'),
          ),
        ),
        React.createElement(
          'label',
          null,
          'Кількість сторінок',
          React.createElement('input', {
            name: 'targetPages',
            type: 'number',
            min: 1,
            max: 2147483647,
            step: 1,
            required: true,
          }),
        ),
        React.createElement('button', { type: 'submit' }, 'Зберегти ціль'),
      ),
      React.createElement(
        'ul',
        null,
        ...['week', 'month'].flatMap((period) => {
          const goal = readingGoals[period];
          if (!goal) {
            return [];
          }
          return [
            React.createElement(
              'li',
              { key: period },
              `${period === 'week' ? 'Тижнева' : 'Місячна'} ціль: ${goal.targetPages} сторінок`,
              React.createElement(
                'button',
                {
                  type: 'button',
                  'data-action': 'delete-reading-goal',
                  'data-period': period,
                  onClick: () => deleteGoal(period),
                },
                'Прибрати ціль',
              ),
            ),
          ];
        }),
      ),
    ),
  );
}

module.exports = { StatisticsDashboard };
