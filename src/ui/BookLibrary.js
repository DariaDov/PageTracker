'use strict';

const React = require('react');

function BookLibrary({ books, pagination, onCreate, onPageChange }) {
  function handleSubmit(event) {
    event.preventDefault();
    const { title, author, totalPages } = event.currentTarget.elements;
    onCreate({
      title: title.value,
      author: author.value,
      totalPages: Number(totalPages.value),
    });
  }

  const pageButtons = Array.from({ length: pagination.totalPages }, (_, index) => {
    const page = index + 1;
    return React.createElement(
      'button',
      {
        key: page,
        type: 'button',
        'aria-current': page === pagination.page ? 'page' : undefined,
        onClick: () => onPageChange(page),
      },
      page,
    );
  });

  return React.createElement(
    'section',
    { className: 'book-library' },
    React.createElement('h1', null, 'Бібліотека'),
    React.createElement(
      'form',
      { onSubmit: handleSubmit },
      React.createElement(
        'label',
        null,
        'Назва книги',
        React.createElement('input', { name: 'title', type: 'text', required: true }),
      ),
      React.createElement(
        'label',
        null,
        'Автор',
        React.createElement('input', { name: 'author', type: 'text', required: true }),
      ),
      React.createElement(
        'label',
        null,
        'Кількість сторінок',
        React.createElement('input', {
          name: 'totalPages',
          type: 'number',
          min: 1,
          step: 1,
          required: true,
        }),
      ),
      React.createElement('button', { type: 'submit' }, 'Додати книгу'),
    ),
    React.createElement(
      'ul',
      null,
      books.map((book) =>
        React.createElement(
          'li',
          { key: book.id },
          React.createElement('h2', null, book.title),
          React.createElement('p', null, `Автор: ${book.author}`),
          React.createElement('p', null, `Статус: ${book.status}`),
          React.createElement('p', null, `Кількість сторінок: ${book.totalPages}`),
          book.rating === null || book.rating === undefined
            ? null
            : React.createElement('p', null, `Рейтинг: ${book.rating}`),
        ),
      ),
    ),
    pagination.totalPages > 1
      ? React.createElement(
          'nav',
          { 'aria-label': 'Сторінки бібліотеки' },
          pageButtons,
        )
      : null,
  );
}

module.exports = { BookLibrary };
