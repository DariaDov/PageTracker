'use strict';

/**
 * @fileoverview Browser entry point for the DOM-based PageTracker application.
 *
 * Handles same-origin API requests, client-side navigation, and rendering
 * without a browser-side React runtime.
 */

const root = document.getElementById('app');
let currentError = '';
let flashMessage = '';
let navigationVersion = 0;

function el(tagName, attributes = {}, ...children) {
  const node = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (name === 'className') {
      node.className = value;
    } else if (name === 'text') {
      node.textContent = value;
    } else if (name === 'value') {
      node.value = value;
    } else if (name === 'checked' || name === 'required' || name === 'disabled') {
      node[name] = Boolean(value);
    } else {
      node.setAttribute(name, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function routeLink(href, label, attributes = {}) {
  return el('a', { href, 'data-route': '', ...attributes }, label);
}

function makeButton(label, action, className = '') {
  const button = el('button', { type: 'button', className }, label);
  button.addEventListener('click', action);
  return button;
}

function field(labelText, name, type, value = '', options = {}) {
  const input = el('input', { name, type, ...options });
  if (value !== undefined && value !== null) {
    input.value = String(value);
  }
  return el('label', {}, labelText, input);
}

function selectField(labelText, name, choices, selected) {
  const select = el('select', { name });
  for (const [value, label] of choices) {
    select.append(el('option', { value, selected: value === selected }, label));
  }
  return el('label', {}, labelText, select);
}

function showError(message) {
  currentError = message;
  const alert = root.querySelector('[data-error]');
  if (alert) {
    alert.textContent = message;
    alert.hidden = !message;
  }
}

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw apiError('Не вдалося з’єднатися із сервером. Спробуйте ще раз.', 0);
  }

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json();
  if (!response.ok) {
    if (response.status >= 500) {
      throw apiError('Внутрішня помилка сервера. Перевірте журнал сервера або спробуйте пізніше.', response.status);
    }
    throw apiError(payload.detail || 'Помилка', response.status);
  }
  return payload.pagination ? payload : payload.data;
}

async function withErrorHandling(operation) {
  currentError = '';
  showError('');
  try {
    await operation();
  } catch (error) {
    showError(error.message || 'Помилка');
  }
}

async function loadAllBooks() {
  const firstPage = await api('/books?page=1');
  const remaining = await Promise.all(
    Array.from({ length: Math.max(firstPage.pagination.totalPages - 1, 0) }, (_, index) =>
      api(`/books?page=${index + 2}`),
    ),
  );
  return firstPage.data.concat(...remaining.map((page) => page.data));
}

function appendFeedback(container) {
  if (flashMessage) {
    container.append(el('p', { className: 'notice', role: 'status' }, flashMessage));
    flashMessage = '';
  }
  container.append(el('p', {
    className: 'error',
    role: 'alert',
    'data-error': '',
    hidden: !currentError,
  }, currentError));
}

function renderShell(content, path) {
  const nav = el(
    'nav',
    { className: 'site-nav', 'aria-label': 'Основна навігація' },
    routeLink('/', 'Головна сторінка', { 'aria-current': path === '/' ? 'page' : undefined }),
    routeLink('/books', 'Бібліотека', { 'aria-current': path.startsWith('/books') ? 'page' : undefined }),
    routeLink('/statistics', 'Статистика', { 'aria-current': path === '/statistics' ? 'page' : undefined }),
    makeButton('Вихід', () => {
      void withErrorHandling(async () => {
        await api('/auth/logout', { method: 'POST' });
        flashMessage = 'Ви вийшли з облікового запису.';
        navigate('/login');
      });
    }, 'secondary'),
  );
  const header = el('header', { className: 'site-header' },
    el('p', { className: 'brand' }, 'PageTracker'),
    nav,
  );
  root.replaceChildren(header, content);
  appendFeedback(content);
}

function renderAuth(path) {
  const registering = path === '/register';
  const title = registering ? 'Створення облікового запису' : 'Вхід';
  const page = el('main', { className: 'auth-page' });
  const card = el('section', { className: 'auth-card', 'aria-labelledby': 'auth-heading' });
  card.append(el('h1', { id: 'auth-heading' }, title));
  appendFeedback(card);

  const form = el('form');
  form.append(
    field('Електронна пошта', 'email', 'email', '', { autocomplete: 'email', required: true }),
    field('Пароль', 'password', 'password', '', {
      autocomplete: registering ? 'new-password' : 'current-password',
      required: true,
    }),
  );
  const submit = el('button', { type: 'submit' }, registering ? 'Зареєструватися' : 'Увійти');
  form.append(el('div', { className: 'actions' }, submit));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void withErrorHandling(async () => {
      const values = new FormData(form);
      const credentials = {
        email: values.get('email'),
        password: values.get('password'),
      };
      if (registering) {
        await api('/auth/register', {
          method: 'POST',
          body: JSON.stringify(credentials),
        });
        flashMessage = 'Реєстрацію завершено. Тепер увійдіть.';
        navigate('/login');
        return;
      }
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      const next = new URLSearchParams(location.search).get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    });
  });

  card.append(form);
  const switchPath = registering ? '/login' : '/register';
  card.append(el('p', { className: 'muted' },
    registering ? 'Вже маєте обліковий запис? ' : 'Ще не маєте облікового запису? ',
    routeLink(switchPath, registering ? 'Увійти' : 'Зареєструватися'),
  ));
  page.append(card);
  root.replaceChildren(page);
}

function renderHome(books) {
  const page = el('main', { className: 'page' }, el('h1', {}, 'Додати запис читання'));
  const availableBooks = books.filter(
    (book) => book.status === 'розпочати' || book.status === 'читається',
  );
  if (availableBooks.length === 0) {
    page.append(el('section', { className: 'panel' },
      el('p', {}, 'Немає книг, доступних для читання.'),
      routeLink('/books', 'Додати книгу', { class: 'button-link' }),
    ));
  } else {
    const form = el('form', { className: 'panel form-grid' });
    const bookSelect = el('select', { name: 'bookId', required: true });
    bookSelect.append(el('option', { value: '', disabled: true, selected: true }, 'Оберіть книгу'));
    for (const book of availableBooks) {
      bookSelect.append(el('option', { value: book.id }, book.title));
    }
    form.append(
      el('label', {}, 'Книга', bookSelect),
      field('Початкова сторінка', 'startPage', 'number', '', { min: 1, step: 1, required: true }),
      field('Кінцева сторінка', 'endPage', 'number', '', { min: 1, step: 1, required: true }),
      el('button', { type: 'submit' }, 'Зберегти запис'),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void withErrorHandling(async () => {
        const values = new FormData(form);
        await api(`/books/${encodeURIComponent(values.get('bookId'))}/reading-records`, {
          method: 'POST',
          body: JSON.stringify({
            startPage: Number(values.get('startPage')),
            endPage: Number(values.get('endPage')),
          }),
        });
        flashMessage = 'Запис читання збережено.';
        navigate('/');
      });
    });
    page.append(form);
  }
  renderShell(page, '/');
}

function renderLibrary(books, pagination) {
  const page = new URLSearchParams(location.search).get('page') ?? '1';
  const content = el('main', { className: 'page' }, el('h1', {}, 'Бібліотека'));
  const form = el('form', { className: 'panel form-grid' });
  form.append(
    field('Назва книги', 'title', 'text', '', { required: true }),
    field('Автор', 'author', 'text', '', { required: true }),
    field('Кількість сторінок', 'totalPages', 'number', '', { min: 1, step: 1, required: true }),
    el('button', { type: 'submit' }, 'Додати книгу'),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void withErrorHandling(async () => {
      const values = new FormData(form);
      const book = await api('/books', {
        method: 'POST',
        body: JSON.stringify({
          title: values.get('title'),
          author: values.get('author'),
          totalPages: Number(values.get('totalPages')),
        }),
      });
      navigate(`/books/${encodeURIComponent(book.id)}`);
    });
  });
  content.append(form);

  if (books.length === 0) {
    content.append(el('p', { className: 'muted' }, 'У бібліотеці поки немає книг.'));
  } else {
    const list = el('ul', { className: 'book-list' });
    for (const book of books) {
      const item = el('li', { className: 'book-card' });
      item.append(
        el('h2', {}, routeLink(`/books/${encodeURIComponent(book.id)}`, book.title, { class: 'book-title' })),
        el('p', {}, `Автор: ${book.author}`),
        el('p', {}, `Статус: ${book.status}`),
        el('p', {}, `Кількість сторінок: ${book.totalPages}`),
        book.rating === null || book.rating === undefined
          ? null
          : el('p', {}, `Рейтинг: ${book.rating}`),
      );
      list.append(item);
    }
    content.append(list);
  }

  if (pagination.totalPages > 1) {
    const nav = el('nav', { className: 'pagination', 'aria-label': 'Сторінки бібліотеки' });
    for (let number = 1; number <= pagination.totalPages; number += 1) {
      nav.append(routeLink(
        `/books?page=${number}`,
        String(number),
        { 'aria-current': String(number) === page ? 'page' : undefined },
      ));
    }
    content.append(nav);
  }
  renderShell(content, '/books');
}

function renderBookDetails(book, records) {
  const content = el('main', { className: 'page' });
  const details = el('article', { className: 'stack' });
  const overview = el('section', { className: 'panel' });
  overview.append(
    el('h1', {}, book.title),
    el('p', {}, `Автор: ${book.author}`),
    el('p', {}, `Статус: ${book.status}`),
    el('p', {}, `Кількість сторінок: ${book.totalPages}`),
    el('p', {}, book.rating == null ? 'Рейтинг: немає' : `Рейтинг: ${book.rating}`),
  );
  overview.append(makeButton('Видалити книгу', () => {
    if (!window.confirm('Ви хочете видалити цю книгу')) {
      return;
    }
    void withErrorHandling(async () => {
      await api(`/books/${encodeURIComponent(book.id)}`, { method: 'DELETE' });
      flashMessage = 'Книгу видалено.';
      navigate('/books');
    });
  }, 'danger'));

  const metadataForm = el('form', { className: 'panel form-grid' });
  metadataForm.append(
    field('Назва книги', 'title', 'text', book.title, { required: true }),
    field('Автор', 'author', 'text', book.author, { required: true }),
    el('button', { type: 'submit' }, 'Зберегти зміни'),
  );
  metadataForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void withErrorHandling(async () => {
      const values = new FormData(metadataForm);
      await api(`/books/${encodeURIComponent(book.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: values.get('title'), author: values.get('author') }),
      });
      await renderRoute();
    });
  });

  details.append(overview, metadataForm);
  if (records.length === 0) {
    const pageCountForm = el('form', { className: 'panel form-grid' });
    pageCountForm.append(
      field('Кількість сторінок', 'totalPages', 'number', book.totalPages, {
        min: 1,
        step: 1,
        required: true,
      }),
      el('button', { type: 'submit' }, 'Змінити кількість сторінок'),
    );
    pageCountForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void withErrorHandling(async () => {
        const values = new FormData(pageCountForm);
        await api(`/books/${encodeURIComponent(book.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ totalPages: Number(values.get('totalPages')) }),
        });
        await renderRoute();
      });
    });
    details.append(pageCountForm);
  }

  if (book.status === 'прочитано') {
    const rating = selectField('Рейтинг', 'rating', [
      ['', 'Оберіть оцінку'],
      ...[1, 2, 3, 4, 5].map((value) => [String(value), String(value)]),
    ], book.rating == null ? '' : String(book.rating));
    rating.querySelector('select').addEventListener('change', (event) => {
      if (!event.currentTarget.value) {
        return;
      }
      void withErrorHandling(async () => {
        await api(`/books/${encodeURIComponent(book.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ rating: Number(event.currentTarget.value) }),
        });
        await renderRoute();
      });
    });
    details.append(el('section', { className: 'panel' }, rating));
  }

  const recordsPanel = el('section', { className: 'panel' }, el('h2', {}, 'Записи читання'));
  if (records.length === 0) {
    recordsPanel.append(el('p', { className: 'muted' }, 'Записів читання ще немає.'));
  } else {
    const list = el('ul', { className: 'record-list' });
    for (const record of records) {
      const item = el('li', { className: 'record-item' });
      item.append(
        el('time', { dateTime: record.date }, record.date),
        ` — ${record.pagesRead} сторінок`,
      );
      if (book.status === 'читається') {
        const recordForm = el('form', { className: 'form-grid' });
        recordForm.append(
          field('Початкова сторінка', 'startPage', 'number', record.startPage, {
            min: 1,
            step: 1,
            required: true,
          }),
          field('Кінцева сторінка', 'endPage', 'number', record.endPage, {
            min: 1,
            step: 1,
            required: true,
          }),
          el('button', { type: 'submit' }, 'Зберегти запис'),
        );
        recordForm.addEventListener('submit', (event) => {
          event.preventDefault();
          void withErrorHandling(async () => {
            const values = new FormData(recordForm);
            await api(`/reading-records/${encodeURIComponent(record.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({
                startPage: Number(values.get('startPage')),
                endPage: Number(values.get('endPage')),
              }),
            });
            await renderRoute();
          });
        });
        item.append(recordForm, makeButton('Видалити запис', () => {
          if (!window.confirm('Ви хочете видалити цей запис')) {
            return;
          }
          void withErrorHandling(async () => {
            await api(`/reading-records/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
            await renderRoute();
          });
        }, 'danger'));
      }
      list.append(item);
    }
    recordsPanel.append(list);
  }
  details.append(recordsPanel);
  content.append(details);
  renderShell(content, '/books');
}

function renderStatistics(statistics, goals, period, date) {
  const content = el('main', { className: 'page' }, el('h1', {}, 'Статистика'));
  const periodForm = el('form', { className: 'panel form-grid' });
  periodForm.append(
    selectField('Період', 'period', [
      ['week', 'Тиждень'],
      ['month', 'Місяць'],
      ['year', 'Рік'],
    ], period),
    field('Опорна дата', 'date', 'date', date, { required: true }),
    el('button', { type: 'submit' }, 'Показати'),
  );
  periodForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(periodForm);
    const query = new URLSearchParams({
      period: values.get('period'),
      date: values.get('date'),
    });
    navigate(`/statistics?${query}`);
  });
  content.append(periodForm);

  const statsPanel = el('section', { className: 'panel' });
  statsPanel.append(el('p', {}, `Період: ${statistics.period.startDate} — ${statistics.period.endDate}`));
  if (statistics.hasData) {
    const grid = el('div', { className: 'stat-grid' });
    grid.append(
      el('article', { className: 'stat-card' }, 'Середнє за день', el('strong', {}, `${statistics.averagePagesPerDay} сторінок`)),
      el('article', { className: 'stat-card' }, 'Днів у періоді', el('strong', {}, statistics.daysCounted)),
      el('article', { className: 'stat-card' }, 'Усього прочитано', el('strong', {}, `${statistics.pagesReadTotal} сторінок`)),
    );
    statsPanel.append(grid);
  } else {
    statsPanel.append(el('p', {}, statistics.message));
  }
  content.append(statsPanel);

  const goalsPanel = el('section', { className: 'panel' }, el('h2', {}, 'Цілі читання'));
  if (statistics.goalProgress) {
    const progress = statistics.goalProgress;
    goalsPanel.append(
      el('h3', {}, period === 'week' ? 'Ціль на тиждень' : 'Ціль на місяць'),
      el('p', {}, `Прочитано: ${progress.pagesRead} із ${progress.targetPages} сторінок`),
      el('p', {}, `Залишилося: ${progress.remainingPages} сторінок`),
      el('progress', {
        className: 'progress',
        max: 100,
        value: Math.min(progress.percentage, 100),
        'aria-label': `Виконано ${Math.round(progress.percentage)} відсотків`,
      }),
      el('p', {}, `Виконано: ${Math.round(progress.percentage)}%`),
      el('p', {}, progress.achieved ? 'Ціль досягнуто' : 'Ціль ще не досягнуто'),
    );
  }

  const goalForm = el('form', { className: 'form-grid' });
  const goalPeriod = period === 'month' ? 'month' : 'week';
  goalForm.append(
    selectField('Період цілі', 'period', [['week', 'Тиждень'], ['month', 'Місяць']], goalPeriod),
    field(
      'Кількість сторінок',
      'targetPages',
      'number',
      goals[goalPeriod]?.targetPages ?? '',
      { min: 1, max: 2147483647, step: 1, required: true },
    ),
    el('button', { type: 'submit' }, 'Зберегти ціль'),
  );
  goalForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void withErrorHandling(async () => {
      const values = new FormData(goalForm);
      await api(`/reading-goals/${values.get('period')}`, {
        method: 'PUT',
        body: JSON.stringify({ targetPages: Number(values.get('targetPages')) }),
      });
      await renderRoute();
    });
  });
  goalsPanel.append(goalForm);

  const goalList = el('ul', { className: 'goal-list' });
  for (const periodName of ['week', 'month']) {
    const goal = goals[periodName];
    if (!goal) {
      continue;
    }
    const label = periodName === 'week' ? 'Тижнева' : 'Місячна';
    const item = el('li', { className: 'goal-item' },
      `${label} ціль: ${goal.targetPages} сторінок`,
      makeButton('Прибрати ціль', () => {
        void withErrorHandling(async () => {
          await api(`/reading-goals/${periodName}`, { method: 'DELETE' });
          await renderRoute();
        });
      }, 'secondary'),
    );
    goalList.append(item);
  }
  goalsPanel.append(goalList);
  content.append(goalsPanel);
  renderShell(content, '/statistics');
}

function todayInKyiv() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function renderRoute() {
  const version = ++navigationVersion;
  currentError = '';
  const url = new URL(location.href);
  const path = url.pathname;
  if (path === '/login' || path === '/register') {
    renderAuth(path);
    return;
  }

  root.replaceChildren(el('main', { className: 'loading', role: 'status' }, 'Завантаження…'));
  try {
    if (path === '/') {
      const books = await loadAllBooks();
      if (version === navigationVersion) {
        renderHome(books);
      }
    } else if (path === '/books') {
      const requestedPage = url.searchParams.get('page') ?? '1';
      const result = await api(`/books?page=${encodeURIComponent(requestedPage)}`);
      if (version === navigationVersion) {
        renderLibrary(result.data, result.pagination);
      }
    } else if (/^\/books\/[^/]+$/.test(path)) {
      const bookId = decodeURIComponent(path.slice('/books/'.length));
      const [book, records] = await Promise.all([
        api(`/books/${encodeURIComponent(bookId)}`),
        api(`/books/${encodeURIComponent(bookId)}/reading-records`),
      ]);
      if (version === navigationVersion) {
        renderBookDetails(book, records);
      }
    } else if (path === '/statistics') {
      const period = url.searchParams.get('period') ?? 'week';
      const date = url.searchParams.get('date') ?? todayInKyiv();
      const query = new URLSearchParams({ period, date });
      const [statistics, goals] = await Promise.all([
        api(`/statistics?${query}`),
        api('/reading-goals'),
      ]);
      if (version === navigationVersion) {
        renderStatistics(statistics, goals, period, date);
      }
    } else {
      navigate('/login');
    }
  } catch (error) {
    if (version !== navigationVersion) {
      return;
    }
    if (error.status === 401) {
      const next = `${path}${url.search}`;
      navigate(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    currentError = error.message || 'Помилка';
    const page = el('main', { className: 'page' }, el('h1', {}, 'PageTracker'));
    renderShell(page, path);
    showError(currentError);
  }
}

function navigate(path) {
  history.pushState({}, '', path);
  void renderRoute();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  navigate(link.href);
});

window.addEventListener('popstate', () => void renderRoute());
void renderRoute();
