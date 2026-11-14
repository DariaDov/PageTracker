'use strict';

/**
 * @fileoverview Shared navigation and shell for authenticated React pages.
 */

const React = require('react');

/**
 * Renders the authenticated page shell with primary navigation and logout.
 *
 * @param {object} props Component properties.
 * @param {import('react').ReactNode} props.children Page content.
 * @param {() => void} props.onLogout Called when the user requests logout.
 * @returns {import('react').ReactElement} Authenticated layout.
 */
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
