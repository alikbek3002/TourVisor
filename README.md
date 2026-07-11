# Aisuluu Tourbot 🏖️

AI-бот для WhatsApp, который подбирает туры через **Tourvisor API** и, когда клиент готов купить или возникает проблема, передаёт диалог менеджеру с уведомлением в **Telegram**.

- **Мозг** — Claude (Anthropic) с tool-use: сам ведёт диалог, выясняет параметры, ищет туры и решает, когда звать человека.
- **WhatsApp** — через [WAHA](https://waha.devlike.pro/) (self-hosted шлюз, разворачивается в Docker).
- **Поиск туров** — Tourvisor XML/JSON API (`search.php` → `result.php`).
- **Уведомления** — Telegram-бот пишет администратору с кнопкой «Написать клиенту».
- **Хостинг** — Railway (два сервиса: бот + WAHA).

---

## Как это работает

```
                         (1) сообщение
  Клиент ──WhatsApp──▶ WAHA (Docker) ──webhook──▶  Бот (Node/TS)
        ◀─WhatsApp──── sendText ◀── ответ ─────────┤
                                                    │ (2) tool-use loop
                                                    ▼
                                              Claude (Anthropic)
                                     ┌──────────────┼───────────────┐
                                     ▼ search_tours ▼ escalate      ▼ collect_lead
                               Tourvisor API   Telegram-бот      память диалога
                              (поиск + ссылки)  (уведомление        (лид)
                                                 менеджеру)
```

**Сценарии передачи менеджеру** (инструмент `escalate_to_manager`):
- клиент готов бронировать/оплачивать → 🟢 уведомление «клиент готов к покупке»;
- клиент просит человека → 🟡;
- жалоба / проблема с уже купленным туром → 🔴 (со срочностью);
- вопрос вне подбора (визы, возвраты) → передача менеджеру.

После вызова бот замолкает по этому чату (`bot_paused`), а менеджер получает в Telegram сообщение с номером клиента, сутью запроса и кнопкой **«Написать клиенту в WhatsApp»** (`wa.me`-ссылка).

---

## Что понадобится (аккаунты и ключи)

| Сервис | Что получить | Где |
|---|---|---|
| **Anthropic** | `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| **Tourvisor** | логин/пароль кабинета (ЛК) + подключённый тариф «Поиск туров API» | https://tourvisor.ru/b2b/ddapi + поддержка |
| **Telegram** | токен бота (`@BotFather`) + ваш `chat_id` (`@userinfobot`) | Telegram |
| **WhatsApp** | отдельный номер для бота (не личный!) | телефон/SIM |
| **Railway** | аккаунт | https://railway.com |

> ⚠️ WAHA использует WhatsApp Web (неофициальный способ). Используйте **отдельный номер** и человеческий темп ответов — бот уже отправляет «прочитано» и «печатает…», чтобы выглядеть естественно и снизить риск блокировки.

---

## Локальный запуск (Docker Compose)

Самый простой способ всё проверить локально.

```bash
cp .env.example .env
# заполните ANTHROPIC_API_KEY, TOURVISOR_AUTH_LOGIN/PASS, TELEGRAM_*,
# и придумайте WAHA_API_KEY (любая строка)

docker compose up --build
```

1. Откройте **http://localhost:3000/dashboard** (логин/пароль `waha`/`waha`).
2. Запустите сессию **`default`** и **отсканируйте QR-код** телефоном бота (WhatsApp → Связанные устройства).
3. Напишите на номер бота — он ответит.

Бот слушает на `http://localhost:8080`, WAHA — на `http://localhost:3000`. WAHA сам шлёт входящие на `http://bot:3000/webhooks/waha` (настроено в `docker-compose.yml`).

### Без Docker (только бот)

```bash
npm install
npm run dev          # tsx watch, читает .env
```
При этом WAHA нужно поднять отдельно (`docker run ... devlikeapro/waha`) и указать `WAHA_BASE_URL`.

---

## Деплой на Railway

В проекте Railway создаются **два сервиса**: `waha` (шлюз) и `bot` (этот репозиторий). Они общаются по приватной сети Railway.

### Шаг 1. Сервис WAHA

**New → Empty Service → Deploy from Docker Image**: `devlikeapro/waha:latest`

Переменные окружения WAHA:

| Переменная | Значение |
|---|---|
| `WHATSAPP_DEFAULT_ENGINE` | `NOWEB` *(лёгкий, без Chromium — не съест память на малом плане)* |
| `WAHA_API_KEY` | придумайте секрет (тот же укажем боту) |
| `WAHA_LOCAL_STORE_BASE_DIR` | `/data/.sessions` |
| `WHATSAPP_FILES_FOLDER` | `/data/.media` |
| `WHATSAPP_START_SESSION` | `default` |
| `WHATSAPP_RESTART_ALL_SESSIONS` | `True` |
| `WHATSAPP_HOOK_URL` | `http://bot.railway.internal:3000/webhooks/waha` *(добавьте `/<секрет>`, если задали `WAHA_WEBHOOK_SECRET`)* |
| `WHATSAPP_HOOK_EVENTS` | `message` |
| `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD` | логин/пароль для дашборда |

**Обязательно добавьте Volume** и примонтируйте его в **`/data`** (Settings → Volumes). Иначе после каждого редеплоя придётся заново сканировать QR.

Включите публичный домен для WAHA (Settings → Networking → Generate Domain), чтобы открыть дашборд и отсканировать QR.

> `bot.railway.internal` — приватное имя сервиса `bot`. Если назвали сервис иначе — поправьте имя. Порт `3000` — тот, что слушает бот (см. ниже).

### Шаг 2. Сервис бота (этот репозиторий)

**New → GitHub Repo** (подключите этот репозиторий). Railway соберёт его по `Dockerfile` (см. `railway.json`).

Переменные окружения бота:

| Переменная | Значение |
|---|---|
| `ANTHROPIC_API_KEY` | ключ Anthropic |
| `CLAUDE_MODEL` | `claude-sonnet-5` *(баланс цена/скорость; `claude-opus-4-8` — максимум качества)* |
| `TOURVISOR_AUTH_LOGIN` / `TOURVISOR_AUTH_PASS` | логин/пароль кабинета Tourvisor |
| `TOURVISOR_DEFAULT_DEPARTURE` | id города вылета по умолчанию (см. ниже) |
| `TOURVISOR_CURRENCY` | `0` RUB / `1` USD-EUR / `2` BYN / `3` KZT |
| `WAHA_BASE_URL` | `http://waha.railway.internal:3000` |
| `WAHA_API_KEY` | тот же секрет, что у WAHA |
| `WAHA_SESSION` | `default` |
| `WAHA_WEBHOOK_SECRET` | *(опционально)* секрет в пути вебхука |
| `TELEGRAM_BOT_TOKEN` | токен бота |
| `TELEGRAM_ADMIN_CHAT_ID` | chat_id администратора/группы (несколько — через запятую) |
| `COMPANY_NAME`, `MANAGER_NAME`, `MANAGER_WHATSAPP` | данные агентства |
| `ALLOWLIST` | *(опционально)* список номеров через запятую для теста |
| `DATABASE_URL` | *(опционально)* Postgres для хранения диалогов между рестартами |

> Railway задаёт `PORT` автоматически; бот его читает. В `WHATSAPP_HOOK_URL` и `WAHA_BASE_URL` порт `3000` — это внутренний порт, на котором Express слушает `PORT`. Если Railway выдаст другой `PORT`, укажите тот же номер в URL-ах (или задайте `PORT=3000` явно у сервиса бота).

### Шаг 2½. Postgres (хранение диалогов)

**New → Database → Add PostgreSQL.** Затем в сервисе бота добавьте переменную `DATABASE_URL` как ссылку на приватный URL базы (Variables → Add Reference → Postgres `DATABASE_URL`). Бот сам создаст таблицу при старте. Без этого шага активные диалоги и режим «менеджер» теряются при каждом редеплое.

### Шаг 3. Подключить WhatsApp

Откройте публичный домен WAHA → `/dashboard` → сессия `default` → **отсканируйте QR** телефоном бота. Статус должен стать **`WORKING`**. Готово — пишите боту.

---

## Настройка Tourvisor

1. Подключите тариф **«Поиск туров API»** на https://tourvisor.ru/b2b/ddapi и запросите доступ у поддержки.
2. `authlogin`/`authpass` — это **логин и пароль вашего кабинета** (не отдельный токен).
3. **Город вылета:** узнайте id так (подставьте свои логин/пароль):
   ```
   https://tourvisor.ru/xml/list.php?authlogin=ВАШ_ЛОГИН&authpass=ВАШ_ПАРОЛЬ&type=departure&format=json
   ```
   Найдите нужный город и впишите его `id` в `TOURVISOR_DEFAULT_DEPARTURE`.
4. Поиск асинхронный: бот запускает `search.php`, ждёт ~4–20 c и присылает 2–4 лучших варианта с ценой и ссылкой на отель. Клиент может уточнить параметры — бот перезапустит поиск.

> ⚠️ Города вылета и страны на портале tourvisor.ru — российские. Для вылетов из Бишкека/Алматы уточните у Tourvisor доступность нужного портала/направлений.

---

## Настройка Telegram

1. В `@BotFather` создайте бота → получите **токен** → `TELEGRAM_BOT_TOKEN`.
2. Напишите вашему боту любое сообщение, затем узнайте свой `chat_id` через `@userinfobot` → `TELEGRAM_ADMIN_CHAT_ID`.
3. Хотите уведомления в группу? Добавьте бота в группу и используйте её `chat_id` (обычно с минусом).

Проверить можно так — при готовности клиента к покупке в чат придёт карточка с кнопкой «Написать клиенту».

### Управление ботом из Telegram

Бот принимает команды от админ-чата (через webhook, если задан `PUBLIC_URL`, иначе через long-polling):

- `/status` — статус WhatsApp-сессии и диалогов;
- `/resume <номер>` — вернуть диалог боту после передачи менеджеру;
- `/pause <номер> [минуты]` — поставить бота на паузу по конкретному чату;
- `/qr` — прислать QR для подключения WhatsApp.

В каждой карточке эскалации есть кнопка **«▶️ Вернуть диалог боту»** — один тап возвращает авто-ответы. Когда WhatsApp-сессия не подключена, бот сам присылает QR-код в админ-чат (если Telegram настроен).

---

## Выбор модели Claude

По умолчанию — **`claude-sonnet-5`**: почти уровень Opus на диалоговых/агентных задачах, но заметно дешевле и быстрее, что важно для потока сообщений в WhatsApp. Для максимального качества поставьте `CLAUDE_MODEL=claude-opus-4-8`. Для экономии на простых диалогах — `claude-haiku-4-5`.

---

## Структура проекта

```
src/
  index.ts                 старт: персистентность + сервер + справочники + WAHA + Telegram
  server.ts                Express: /health + вебхуки WAHA и Telegram
  config.ts                валидация env (zod), фиче-флаги
  core/
    conversation.ts        память диалогов (per-chat, режим бот/человек) + write-behind в БД
    persistence.ts         Postgres-хранилище диалогов (опционально, DATABASE_URL)
    allowlist.ts           проверка разрешённых номеров (чистая функция)
    pipeline.ts            входящее → агент → ответ (сериализация по чату)
    types.ts               доменные типы (варианты туров)
  routes/
    health.ts              /health
    waha.webhook.ts        приём входящих от WAHA (ACK 200 сразу)
    telegram.webhook.ts    приём апдейтов Telegram (управление ботом)
  services/
    claude/                агент (tool-use loop), инструменты, системный промпт
    tourvisor/             клиент API, кэш справочников, поиск туров
    waha/                  клиент WhatsApp, парсинг вебхука, bootstrap, QR
    telegram/              уведомления + управление (resume/pause/status/qr)
  util/http.ts             fetch с таймаутом и ретраями
test/                      юнит- и интеграционные тесты (vitest)
Dockerfile, docker-compose.yml, railway.json
```

## Команды

```bash
npm run dev        # локальная разработка (tsx watch)
npm run build      # компиляция в dist/
npm start          # запуск собранного
npm run typecheck  # проверка типов
npm run lint       # ESLint
npm test           # юнит-тесты (vitest)
```

## Примечания и ограничения

- **Хранилище диалогов** — при заданном `DATABASE_URL` диалоги и режим «бот/человек» сохраняются в Postgres и переживают рестарт (рабочий набор в памяти, запись в БД — write-behind). Без `DATABASE_URL` — только в памяти процесса (теряется при редеплое). Рассчитано на одну инстанцию Railway.
- **WAHA persistence** — обязательно смонтируйте Volume в `/data`, иначе QR слетает при редеплое.
- **Двойные вебхуки** — настраивайте вебхук либо через `WHATSAPP_HOOK_URL` у WAHA (рекомендуется), либо через `WAHA_AUTOREGISTER=true` у бота, но не одновременно.
- **tourid живёт ~24 часа** — постоянных ссылок «на тур» у Tourvisor нет; для отеля используется `fulldesclink`, финальную бронь оформляет менеджер.
- **Same-IP** — Tourvisor требует опрашивать результаты с того же IP, что запустил поиск; на одном сервисе Railway это выполняется автоматически.
