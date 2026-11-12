'use strict';

const React = require('react');

function BookDetails({
  book,
  records,
  onUpdate,
  onRate,
  onUpdateRecord,
  onDeleteRecord,
  onDeleteBook,
}) {
  function submitMetadata(event) {
    event.preventDefault();
    const { title, author } = event.currentTarget.elements;
    onUpdate({ title: title.value, author: author.value });
  }

  function submitPageCount(event) {
    event.preventDefault();
    const { totalPages } = event.currentTarget.elements;
    onUpdate({ totalPages: Number(totalPages.value) });
  }

  function submitRecordUpdate(event, record) {
    event.preventDefault();
    const { startPage, endPage } = event.currentTarget.elements;
    onUpdateRecord(record.id, {
      startPage: Number(startPage.value),
      endPage: Number(endPage.value),
    });
  }

  const orderedRecords = [...records].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.startPage - right.startPage ||
      left.id.localeCompare(right.id),
  );

  return React.createElement(
    'article',
    { className: 'book-details' },
    React.createElement('h1', null, book.title),
    typeof onDeleteBook === 'function'
      ? React.createElement(
          'button',
          {
            type: 'button',
            'data-delete-book': book.id,
            onClick: (event) => {
              event.preventDefault();
              if (globalThis.confirm('Ви хочете видалити цю книгу')) {
                onDeleteBook(book.id);
              }
            },
          },
          'Видалити книгу',
        )
      : null,
    React.createElement('p', null, `Автор: ${book.author}`),
    React.createElement('p', null, `Статус: ${book.status}`),
    React.createElement('p', null, `Кількість сторінок: ${book.totalPages}`),
    React.createElement(
      'p',
      null,
      book.rating === null || book.rating === undefined
        ? 'Рейтинг: немає'
        : `Рейтинг: ${book.rating}`,
    ),
    React.createElement(
      'form',
      { 'data-form': 'metadata', onSubmit: submitMetadata },
      React.createElement(
        'label',
        null,
        'Назва книги',
        React.createElement('input', {
          name: 'title',
          type: 'text',
          defaultValue: book.title,
          required: true,
        }),
      ),
      React.createElement(
        'label',
        null,
        'Автор',
        React.createElement('input', {
          name: 'author',
          type: 'text',
          defaultValue: book.author,
          required: true,
        }),
      ),
      React.createElement('button', { type: 'submit' }, 'Зберегти зміни'),
    ),
    records.length === 0
      ? React.createElement(
          'form',
          { 'data-form': 'page-count', onSubmit: submitPageCount },
          React.createElement(
            'label',
            null,
            'Кількість сторінок',
            React.createElement('input', {
              name: 'totalPages',
              type: 'number',
              min: 1,
              step: 1,
              defaultValue: book.totalPages,
              required: true,
            }),
          ),
          React.createElement('button', { type: 'submit' }, 'Змінити кількість сторінок'),
        )
      : null,
    book.status === 'прочитано'
      ? React.createElement(
          'label',
          null,
          'Рейтинг',
          React.createElement(
            'select',
            {
              name: 'rating',
              value: book.rating ?? '',
              onChange: (event) => onRate(Number(event.currentTarget.value)),
            },
            React.createElement('option', { value: '' }, 'Оберіть оцінку'),
            ...[1, 2, 3, 4, 5].map((rating) =>
              React.createElement('option', { key: rating, value: rating }, rating),
            ),
          ),
        )
      : null,
    React.createElement('h2', null, 'Записи читання'),
    records.length > 0
      ? React.createElement(
          'ul',
          null,
          orderedRecords.map((record) =>
            React.createElement(
              'li',
              { key: record.id },
              React.createElement('time', { dateTime: record.date }, record.date),
              ` — ${record.pagesRead} сторінок`,
              book.status === 'читається'
                ? React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      'form',
                      {
                        'data-form': 'reading-record',
                        'data-record-id': record.id,
                        onSubmit: (event) => submitRecordUpdate(event, record),
                      },
                      React.createElement(
                        'label',
                        null,
                        'Початкова сторінка',
                        React.createElement('input', {
                          name: 'startPage',
                          type: 'number',
                          min: 1,
                          step: 1,
                          defaultValue: record.startPage,
                          required: true,
                        }),
                      ),
                      React.createElement(
                        'label',
                        null,
                        'Кінцева сторінка',
                        React.createElement('input', {
                          name: 'endPage',
                          type: 'number',
                          min: 1,
                          step: 1,
                          defaultValue: record.endPage,
                          required: true,
                        }),
                      ),
                      React.createElement('button', { type: 'submit' }, 'Зберегти запис'),
                    ),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        'data-delete-record': record.id,
                        onClick: (event) => {
                          event.preventDefault();
                          if (globalThis.confirm('Ви хочете видалити цей запис')) {
                            onDeleteRecord(record.id);
                          }
                        },
                      },
                      'Видалити запис',
                    ),
                  )
                : null,
            ),
          ),
        )
      : React.createElement('p', null, 'Записів читання ще немає'),
  );
}

module.exports = { BookDetails };
