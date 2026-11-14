'use strict';

/**
 * @fileoverview React form for adding a reading record to an eligible book.
 */

const React = require('react');

/**
 * Renders a form for recording the inclusive page range read in a book.
 *
 * Completed books are excluded; when no eligible books exist, the component
 * displays an explanatory message instead of the form.
 *
 * @param {object} props Component properties.
 * @param {Array<{id: string, title: string, status: string}>} props.books
 *   User's books.
 * @param {(record: {bookId: string, startPage: number, endPage: number}) => void}
 *   props.onCreate Called with the submitted reading range.
 * @returns {import('react').ReactElement} Reading form or empty-state message.
 */
function HomeReadingForm({ books, onCreate }) {
  const availableBooks = books.filter(
    (book) => book.status === 'розпочати' || book.status === 'читається',
  );

  function handleSubmit(event) {
    event.preventDefault();
    const { bookId, startPage, endPage } = event.currentTarget.elements;
    onCreate({
      bookId: bookId.value,
      startPage: Number(startPage.value),
      endPage: Number(endPage.value),
    });
  }

  return React.createElement(
    'section',
    { className: 'home-reading-form' },
    React.createElement('h1', null, 'Додати запис читання'),
    availableBooks.length > 0
      ? React.createElement(
        'form',
        { onSubmit: handleSubmit },
        React.createElement(
          'label',
          null,
          'Книга',
          React.createElement(
            'select',
            { name: 'bookId', required: true, defaultValue: '' },
            React.createElement('option', { value: '', disabled: true }, 'Оберіть книгу'),
            ...availableBooks.map((book) =>
              React.createElement(
                'option',
                { key: book.id, value: book.id },
                book.title,
              ),
            ),
          ),
        ),
        React.createElement(
          'label',
          null,
          'Початкова сторінка',
          React.createElement('input', {
            name: 'startPage',
            type: 'number',
            min: 1,
            step: 1,
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
            required: true,
          }),
        ),
        React.createElement('button', { type: 'submit' }, 'Зберегти запис'),
      )
      : React.createElement('p', null, 'Немає книг, доступних для читання'),
  );
}

module.exports = { HomeReadingForm };
