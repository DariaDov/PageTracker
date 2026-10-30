# Mock API PageTracker

Mock API створюється без серверної реалізації за специфікацією [openapi.yaml](./openapi.yaml) через Stoplight Prism.

**Статус контракту:** API-CL-01…12 у [api-contract-addendum.md](./api-contract-addendum.md) погоджені на API-GATE 2026-10-30. Mock відтворює затверджений контракт, але не реалізує стан і бізнес-правила сервера.

## Запуск

Із кореня репозиторію запустити:

```bash
npx --yes @stoplight/prism-cli mock spec/openapi.yaml --host 127.0.0.1 --port 4010
```

Prism оголошує маршрути без базового префікса `servers.url`, тому для `servers.url: /api` запитувати треба `/books`, `/auth/login`, `/statistics`, а не `/api/books` тощо.

Для захищених операцій передавати тестову cookie:

```bash
curl -i 'http://127.0.0.1:4010/books?page=1' \
  -H 'Cookie: pt_session=mock-session'
```

Mock повертає приклади даних зі специфікації й не зберігає зміни між запитами. Успішний mock-вхід повертає демонстраційну cookie, але не створює справжню користувацьку сесію.

## Негативні приклади

Приклади Problem Details у OpenAPI дають детерміновані форми помилок. Для конкретного негативного прикладу Prism можна попросити використати HTTP-код і названий example через заголовок `Prefer`:

```bash
curl -i -X POST \
  'http://127.0.0.1:4010/books/book-1/reading-records' \
  -H 'Cookie: pt_session=mock-session' \
  -H 'Content-Type: application/json' \
  -H 'Prefer: code=422, example=invalidPageRange' \
  --data '{"startPage":10,"endPage":1}'
```

Назви прикладів помилок визначені в `components.responses` у OpenAPI. Наприклад: `missingSession`, `invalidPage`, `invalidBook`, `invalidPageRange`, `overlappingPages`, `skippedPages`, `forbiddenRecordDeletion`, `resourceNotFound` та `internalError`. Для реєстрації й входу є відповідні приклади `duplicateEmail` і `invalidCredentials`.

Prism самостійно перевіряє лише обмеження, виражені схемами (типи, обов’язкові поля, діапазони, enum). Він не відстежує стан користувачів, книг або записів, тому не може сам визначити, що пошта вже існує, книга завершена, діапазон перетинається з наявним записом або видалення спричинить розрив. Для таких сценаріїв `Prefer: code=..., example=...` лише вибирає приклад відповіді — це не виконання бізнес-правила. Перевірка повної поведінки потребуватиме окремого stateful mock із правилами/станом або реалізованого API; серверна реалізація не входить до цього mock.

## Перевірка відповіді

Перевірити тіло й статус відповіді окремо:

```bash
curl -i 'http://127.0.0.1:4010/books' \
  -H 'Cookie: pt_session=mock-session' \
  -H 'Prefer: code=401, example=missingSession'
```

Для стандартних успішних відповідей не встановлювати `Prefer`; Prism генерує приклад за відповідною схемою. Цей mock призначений для раннього узгодження контракту та інтеграції клієнта, а не для перевірки авторизації, персистентності, транзакцій або правил предметної області.
