'use strict';

const React = require('react');

function AuthenticatedLayout({ children, onLogout }) {
  return React.createElement(
    'div',
    { className: 'authenticated-layout' },
    React.createElement(
      'header',
      null,
      React.createElement(
        'nav',
        { 'aria-label': 'Основна навігація' },
        React.createElement('a', { href: '/' }, 'Головна сторінка'),
        React.createElement('a', { href: '/books' }, 'Бібліотека'),
        React.createElement('a', { href: '/statistics' }, 'Статистика'),
      ),
      React.createElement('button', { type: 'button', onClick: onLogout }, 'Вихід'),
    ),
    children,
  );
}

module.exports = { AuthenticatedLayout };
