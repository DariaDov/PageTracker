'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function renderNavigation(overrides = {}) {
  const { AuthenticatedLayout } = require('../src/ui/AuthenticatedLayout.js');
  return renderToStaticMarkup(
    React.createElement(
      AuthenticatedLayout,
      {
        onLogout: () => {},
        ...overrides,
      },
      React.createElement('main', null, 'Вміст сторінки'),
    ),
  );
}

test('TEST-04 / REQ-I-012: authenticated navigation exposes the four Ukrainian sections', () => {
  const markup = renderNavigation();

  assert.match(markup, /<nav\b/);
  assert.match(markup, /href="\/">Головна сторінка<\/a>/);
  assert.match(markup, /href="\/books">Бібліотека<\/a>/);
  assert.match(markup, /href="\/statistics">Статистика<\/a>/);
  assert.match(markup, /<button\b[^>]*>Вихід<\/button>/);
});

test('TEST-04 / REQ-I-002: shared shell labels the navigation accessibly in Ukrainian', () => {
  const markup = renderNavigation();

  assert.match(markup, /aria-label="Основна навігація"/);
  assert.match(markup, /Вихід/);
  assert.match(markup, /Головна сторінка/);
  assert.match(markup, /Бібліотека/);
  assert.match(markup, /Статистика/);
});

test('TEST-04 / FEAT-04: authenticated shell renders the active page content', () => {
  const markup = renderNavigation();

  assert.match(markup, /<main>Вміст сторінки<\/main>/);
});
