# TeamBot: production workspace

Этот документ описывает эксплуатационный контур TeamBot для milestone `chatgpt`: диалоги и история, вложения, артефакты, Google Workspace и расписания. Он предназначен для оператора, который поднимает локальную среду, готовит production, проверяет выпуск и разбирает типовые сбои.

> Важно: секреты, OAuth client secret, токены и реальные пароли в Git не сохраняются. Ниже указаны только имена переменных и места настройки.

## 1. Что входит в milestone

В рабочий контур входят:

- чат с настоящим потоковым AG-UI-ответом;
- долговременная история диалогов через CopilotKit Intelligence;
- приватные вложения беседы;
- создаваемые агентом артефакты;
- подключение Google Drive, Google Docs и Google Sheets;
- пользовательские расписания с выполнением от имени создателя;
- отдельный контур Главного редактора с обязательной проверкой результата.

Основной tenant-пакет находится в `examples/chatgpt`. Декларации навыков в tenant-пакете описывают поведение агента, но сами по себе не выдают доступ к инструментам. Доступ всегда определяется серверным каталогом, точным grant для конкретного Бота и политиками действий.

## 2. Архитектура production

```text
Internet
   |
   v
Nginx/TLS: work-origin.kolodahearthstone.com
   |
   +--> edge-auth (127.0.0.1:3030)
   |
   +--> openbot (127.0.0.1:3021 -> container:3001)
          |
          +--> CopilotKit Intelligence: история и память
          +--> agent-codex:4202/ag-ui
          +--> editor-gateway:8080/ag-ui
          |       +--> editor-analyzer
          |       +--> agent-codex
          +--> artifact-renderer:8080
          +--> agent-computer:4100
          +--> PostgreSQL
          +--> /var/lib/openbot/attachments

routine-worker --внутренний API--> openbot
```

### Компоненты и ответственность

| Компонент | Ответственность | Важное ограничение |
| --- | --- | --- |
| `openbot` | HTTP API, авторизация, собранный web-интерфейс, tool callback, политики и аудит | Публичный доступ только через TLS и доверенный edge |
| CopilotKit Intelligence | Авторитетная история тредов и долговременная память | Обязательная зависимость; режима деградации на локальную историю БД нет |
| `agent-codex` | Выполнение обычных AG-UI-запусков | Его hostname должен быть в allowlist |
| `editor-gateway` | Запуск Главного редактора с анализом и валидацией | Нельзя направлять редактора прямо в `agent-codex` |
| `editor-analyzer` | Проверка редакторского результата | Должен быть доступен gateway по внутренней сети |
| `agent-computer` | Изолированное рабочее пространство и профили браузера | Нельзя монтировать volume вложений |
| `artifact-renderer` | Изолированная генерация PDF | URL и токен задаются парой; публичный порт не нужен |
| `routine-worker` | Поиск наступивших расписаний и запуск через внутренний API | Без worker расписания сохраняются, но не выполняются |
| PostgreSQL | Каналы, политики, grants, аудит, profiles, метаданные вложений, расписания | Бэкапить согласованно с файлами вложений |
| attachment volume | Фактические байты приватных вложений | Доступ только через API, не через агента или web-сервер как статические файлы |

В production Compose сервис `openbot` может использовать встроенный PostgreSQL. Для внешнего PostgreSQL миграции выполняются отдельно и ровно один раз на выпуск.

### История и потоковая передача

AG-UI endpoint должен отдавать реальные события протокола:

- один `RUN_STARTED`;
- последовательные `TEXT_MESSAGE_CONTENT` во время генерации;
- согласованные `TOOL_CALL_*` для инструментов;
- ровно один `RUN_FINISHED` или `RUN_ERROR`.

SSE-комментарий `: keep-alive` отправляется примерно раз в 30 секунд и поддерживает соединение, но не считается прогрессом ответа.

Авторитетная история загружается сервером из CopilotKit Intelligence. Клиентский кэш ограничен и служит только для ускорения интерфейса: до 12 тредов, хвост до 500 сообщений на тред. Транскрипт сначала монтирует последние 60 строк, затем окно может быть увеличено до 180. После завершения запуска поздняя запись истории перепроверяется с задержками `0/250/750/1500/3000 ms`.

Приватное рассуждение модели не сохраняется и не показывается. Если продукт разрешает итоговое объяснение, сохраняется только безопасное резюме.

`AGENT_STALL_TIMEOUT_MS` — watchdog тишины, а не максимальная длительность задачи. Значение `60000` означает ошибку после 60 секунд без полезного события; `0` или отсутствие переменной отключает watchdog.

## 3. Локальный запуск

### Требования

- Docker с Compose;
- Bun актуальной для проекта версии;
- доступ к CopilotKit Intelligence;
- ключ модели;
- совместимый AG-UI runtime для выбранного Бота.

### Первый запуск

```bash
cp .env.example .env
bun install
npx --yes copilotkit@latest login
npx --yes copilotkit@latest project select
npx --yes copilotkit@latest license --write
```

В `.env` задайте реальные значения как минимум для:

```dotenv
TENANT_PACKAGE_DIR=../examples/chatgpt
INTELLIGENCE_API_KEY=<from-secret-store>
COPILOTKIT_LICENSE_TOKEN=<written-by-copilotkit-cli>
OPENAI_API_KEY=<from-secret-store>
```

Для сохранения OAuth-токенов и других зашифрованных значений задайте постоянный `KEY_ENCRYPTION_KEY`. Не используйте временный ключ между перезапусками.

Запустите полный локальный контур:

```bash
bash scripts/start.sh
```

После готовности интерфейс доступен по адресу `http://localhost:3010`.

Скрипт запуска поднимает контейнеры, применяет миграции, запускает API на порту `3001`, приложение на `3010` и локальный worker расписаний. При отсутствии `MANAGED_AGENT_AG_UI_URL` он использует локальный LangGraph endpoint на порту `4201`. Для проверки именно Codex/ChatGPT укажите URL реально запущенного совместимого AG-UI runtime.

Обычный `bun run dev` запускает только приложение и сервер. Он не заменяет полный контур с агентами, компьютером и worker.

Для локального создания PDF нужен отдельно запущенный renderer и согласованная пара:

```dotenv
ARTIFACT_RENDERER_URL=http://<renderer-host>:8080
ARTIFACT_RENDERER_TOKEN=<from-secret-store>
```

Без этой пары остальные типы артефактов работают, а PDF возвращает контролируемую ошибку недоступности возможности.

Для чтения PDF-вложений отдельно запускается `pdf-extractor` и задаётся только его внутренний адрес:

```dotenv
PDF_EXTRACTOR_URL=http://<extractor-host>:8080
```

Extractor не получает actor, Bot, conversation, attachment ID, путь или OAuth-данные — API сначала проверяет доступ, затем отправляет только PDF-байты. Не публикуйте этот сервис наружу.

## 4. Production-конфигурация

### Публичные и несекретные параметры

Точные значения зависят от окружения, но production должен явно задать:

```dotenv
NODE_ENV=production
TENANT_PACKAGE_DIR=/app/examples/chatgpt
OPENBOT_PUBLIC_URL=https://work-origin.kolodahearthstone.com
OPENBOT_APP_URL=https://work-origin.kolodahearthstone.com
TRUSTED_ORIGINS=https://work-origin.kolodahearthstone.com
MANAGED_AGENT_AG_UI_URL=http://agent-codex:4202/ag-ui
AGENT_ENDPOINT_ALLOWED_HOSTS=agent-codex:4202,editor-gateway:8080
AGENT_COMPUTER_URL=http://agent-computer:4100
ATTACHMENT_STORAGE_DIR=/var/lib/openbot/attachments
ATTACHMENT_MAX_BYTES=26214400
ARTIFACT_RENDERER_URL=http://artifact-renderer:8080
PDF_EXTRACTOR_URL=http://pdf-extractor:8080
SERVER_INTERNAL_URL=http://127.0.0.1:3001
CODEX_MAX_ACTIVE_RUNS=4
CODEX_MAX_ACTIVE_RUNS_PER_AGENT=2
CODEX_MAX_QUEUED_RUNS=32
CODEX_MAX_QUEUE_WAIT_MS=60000
CODEX_PROCESS_EXIT_GRACE_MS=5000
```

Также явно задаются URL CopilotKit Intelligence, модели и допустимые уровни reasoning/effort, если они отличаются от проектных defaults.

`agent-codex` допускает одновременно не больше `CODEX_MAX_ACTIVE_RUNS` процессов и не больше `CODEX_MAX_ACTIVE_RUNS_PER_AGENT` процессов одного агента. Остальные запросы ждут в ограниченной очереди. Переполнение возвращает HTTP 429, превышение времени ожидания — HTTP 503; оба ответа содержат `Retry-After`. После завершения turn адаптер даёт процессу `CODEX_PROCESS_EXIT_GRACE_MS` на штатный выход, затем отправляет `SIGKILL` и удерживает слот до подтверждённого `exit`. Отмена HTTP-потока также не освобождает слот раньше фактического завершения процесса, поэтому счётчик не занижает реальную нагрузку. `/health` показывает только безопасные счётчики и лимиты в поле `managedRuns`, без пользовательского содержимого.

`OPENBOT_PUBLIC_URL` определяет OAuth callback. `OPENBOT_APP_URL` определяет, куда браузер вернётся после callback. Оба значения должны указывать на фактически доступный origin и совпадать с настройками reverse proxy.

### Секреты

Создайте и храните в secret manager, а не в Git или Compose-файле:

- `KEY_ENCRYPTION_KEY`;
- пароль в `DATABASE_URL`, если БД внешняя;
- `INTELLIGENCE_API_KEY`;
- `COPILOTKIT_LICENSE_TOKEN`;
- ключ провайдера модели, например `OPENAI_API_KEY`;
- `OPENBOT_SESSION_SECRET`;
- `COMPUTER_TOKEN`;
- `MANAGED_AGENT_TOKEN`;
- `AGENT_TOOL_TOKEN`;
- `WORKER_SHARED_SECRET`;
- `ARTIFACT_RENDERER_TOKEN`;
- ключи внешних источников исследования, если они включены.

`BETTER_AUTH_SECRET` и данные реального identity provider обязательны, если origin доступен пользователям напрямую. Текущий приватный Compose допускает `OPENBOT_SINGLE_USER=true` только за доверенным `edge-auth`; такой origin нельзя выставлять в интернет в обход edge-аутентификации.

Секреты Google Workspace connector вводятся в интерфейсе администратора. Переменные `GOOGLE_OAUTH_CLIENT_ID` и `GOOGLE_OAUTH_CLIENT_SECRET`, если используются, относятся к входу пользователей в сам OpenBot и не заменяют OAuth client коннектора Google Workspace.

В текущем приватном Compose `WORKER_SHARED_SECRET` может переиспользовать значение `AGENT_TOOL_TOKEN`. Runtime поддерживает отдельные значения; их разделение остаётся рекомендуемым усилением. До разделения такие токены нужно считать единым секретом и ротировать одновременно.

## 5. Google Drive, Docs и Sheets

### Google Cloud Console

В Google Cloud выберите или создайте production project и включите API:

- Google Drive API: `drive.googleapis.com`;
- Google Docs API: `docs.googleapis.com`;
- Google Sheets API: `sheets.googleapis.com`.

Создайте OAuth 2.0 Client ID типа **Web application**. Для production внесите точные значения без завершающего `/`:

```text
Authorized JavaScript origin
https://work-origin.kolodahearthstone.com

Authorized redirect URI
https://work-origin.kolodahearthstone.com/api/plugins/oauth/callback
```

Callback также показывается в `/admin/plugins/google-drive`. Значение на этой странице, сформированное из фактического `OPENBOT_PUBLIC_URL`, является источником истины. URI в Google Console должен совпадать посимвольно.

Настройте OAuth consent screen, тестовых пользователей или публикацию приложения и запросите scopes:

```text
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
```

`drive.readonly` относится к restricted scopes. Для внешнего production-приложения потребуется Google verification; при хранении или передаче restricted data Google также может потребовать security assessment. `documents` и `spreadsheets` относятся к sensitive scopes. `drive.file` даёт доступ к созданным приложением или явно выбранным файлам и не заменяет широкое чтение Drive.

Официальные справочники для повторной проверки перед публикацией: [OAuth для web-server приложений](https://developers.google.com/identity/protocols/oauth2/web-server), [scopes Google Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [scopes Google Sheets](https://developers.google.com/workspace/sheets/api/scopes) и [требования OAuth verification](https://support.google.com/cloud/answer/13464321).

### Настройка в TeamBot

1. Откройте `/admin/plugins/google-drive`.
2. Включите Google Workspace connector.
3. Введите OAuth Client ID и Client Secret из Google Cloud Console.
4. Обновите каталог инструментов.
5. Выдайте каждому Боту только необходимые точные grants.
6. Пользователь подключает личный Google-аккаунт на `/settings/connected-accounts/google-drive`.

После добавления нового scope уже подключённый пользователь выбирает **Reconnect or update access**
на этой же странице. Старое согласие не расширяется автоматически.

OAuth-токены хранятся на сервере отдельно для каждого пользователя. Подключение администратора не подключает аккаунты остальных пользователей.

Контроль доступа состоит из четырёх независимых границ:

1. scope, который пользователь согласовал в Google;
2. точный grant инструмента конкретному Боту;
3. policy действия, включая подтверждение опасных операций;
4. audit события на сервере.

Tenant skill влияет на выбор инструмента и форму ответа, но не обходит ни одну из этих границ.

### Доступные операции

Google Workspace connector использует закреплённые REST endpoints Drive v3, Docs v1 и Sheets v4. Актуальный runtime публикует 23 инструмента:

- Drive read: поиск файлов, недавние файлы, содержимое папки, метаданные, чтение содержимого и экспорт;
- Drive bridge/write: импорт Drive-файла во вложения беседы, загрузка вложения в Drive, создание папки и перемещение файла;
- Docs: чтение документа, карта редактирования, создание, добавление текста и замена диапазона;
- Sheets: метаданные, список листов, чтение диапазона, создание таблицы и листа, append/update/clear диапазона.

После обновления приложения обновите каталог и повторно проверьте grants: новый инструмент не должен автоматически становиться доступным существующему Боту.

Импорт из Google ограничен 25 MiB, привязан к точным actor/bot/thread/channel и проходит обычную проверку вложений. Нативные Google Docs импортируются как Markdown, Sheets — как CSV, Slides — как текст. Операция считается write со стороны TeamBot, потому что создаёт новое вложение.

Загрузка в Drive принимает только точное вложение текущей беседы. Создание папки и загрузка используют idempotency fingerprint и `appProperties.openbotOperation`. При неоднозначном сетевом исходе не повторяйте мутацию вручную вслепую: сначала найдите созданный объект. Перемещение требует `confirm=true` и проверки ожидаемого списка родительских папок.

Интерфейс показывает карточку результата только для корректного серверного ответа соответствующего write-инструмента. Ссылки на Docs и Sheets должны вести на закреплённые HTTPS URL Google, а не на произвольный URL из текста модели.

## 6. Вложения

Метаданные вложения хранятся в PostgreSQL, а байты — в приватном `ATTACHMENT_STORAGE_DIR`. В сообщения передаётся непрозрачный UUID, а не файловый путь и не содержимое файла.

Серверные read-only инструменты позволяют агенту:

- перечислить вложения текущей беседы;
- получить безопасные метаданные;
- прочитать ограниченный объём текста поддерживаемого файла.

Авторизация каждый раз выводится из доверенного контекста actor/bot/thread/channel. Знание UUID само по себе не даёт доступ.

Размер одного файла по умолчанию ограничен `ATTACHMENT_MAX_BYTES=26214400` (25 MiB). Код допускает повышение общего лимита до 1 GiB, но конкретный формат или интеграция могут иметь более строгий предел.

PNG, JPEG и WebP могут автоматически передаваться мультимодальной модели только для встроенных Ботов: не более 4 изображений, 5 MiB на изображение и 10 MiB суммарно, с лимитом подготовки 10 секунд и только из последнего пользовательского сообщения. Удалённый AG-UI агент получает непрозрачные ID и безопасный текст, но не байты изображений автоматически.

Поддерживаются валидируемые безопасные типы изображений, текста и офисных документов, включая PDF, DOCX и XLSX. Пользовательский HTML не принимается как обычное вложение; HTML разрешён только как созданный агентом артефакт.

PDF читается через отдельный `pdf-extractor` после обычной проверки actor/bot/thread. Сервис принимает не более 25 MiB, 500 страниц, 20 000 текстовых элементов на страницу, 200 000 на документ и 1 000 000 Unicode code points. Одновременно выполняются две задачи, ещё восемь могут ждать; worker ограничен по памяти и принудительно завершается по дедлайну. Если extractor не настроен или недоступен, остальные вложения продолжают работать, а PDF возвращает контролируемую ошибку без содержимого документа.

Бэкап PostgreSQL и attachment volume должен представлять одну согласованную точку во времени. Восстановление только одной части приводит к потерянным метаданным или отсутствующим байтам.

## 7. Артефакты

Агент создаёт артефакт через `artifacts/create_artifact`. Поддерживаются:

| Формат | Расширение | Поведение preview |
| --- | --- | --- |
| Markdown | `.md` | Безопасный просмотр текста |
| Text | `.txt` | Текст |
| JSON | `.json` | Проверенный и ограниченный JSON |
| CSV | `.csv` | Текст/табличное содержимое |
| SVG | `.svg` | Инертный исходный текст |
| HTML | `.html` | Инертный исходный текст |
| PDF | `.pdf` | sandboxed iframe |

Inline-содержимое ограничено 1 MiB. JSON проверяется с ограничением глубины и количества узлов. Поле `workspacePath` присутствует в схеме, но экспорт из workspace пока возвращает `CAPABILITY_UNAVAILABLE`.

Карточка артефакта показывается только для точного first-party результата `openbot.artifact.v1`. После события интерфейс заново запрашивает авторитетные метаданные через authenticated API. Создание защищено actor/channel/bot/thread/grant/policy и идемпотентной DB lease.

HTML и SVG намеренно не исполняются в интерфейсе. Скачать их можно только как attachment с CSP и `nosniff`; после открытия скачанного файла во внешнем приложении его всё равно следует считать недоверенным.

PDF строится из Markdown в отдельном renderer. Если renderer или токен недоступны, другие форматы продолжают работать.

## 8. Расписания

Расписание создаётся в разговоре через granted routines tools. Управление доступно владельцу на `/routines` (пункт «Расписание»): список, пауза/возобновление, редактирование инструкции, cron и timezone, запуск сейчас, последние 20 запусков и удаление. Целевой канал выбирается при разговорном создании или изменяется самим Ботом через `update_routine`.

Форма самостоятельного создания в `/routines` пока отсутствует: создание выполняется через Бота. Администратор должен включить каталог routines и выдать Боту точные grants для создания, изменения, удаления и просмотра расписаний.

Правила:

- расписание принадлежит создателю и выполняется с его grants;
- результат публикуется в выбранный канал владельца;
- cron состоит из 5 полей;
- timezone задаётся IANA-именем, например `Europe/Moscow`;
- минимальный интервал — 15 минут;
- максимум — 20 активных расписаний на пользователя;
- инструкция — до 2000 Unicode code points;
- при пересечении запусков новая попытка пропускается;
- ручной «запустить сейчас» возвращает conflict, если запуск уже идёт.

Worker использует `WORKER_SHARED_SECRET` и `SERVER_INTERNAL_URL`. Sweep по умолчанию берёт до 50 задач. Grace period — 10 минут: более старые пропущенные окна не переигрываются. Lease очереди — 60 секунд, зависший run считается abandoned после 40 минут.

Страница расписаний отдельно показывает durable heartbeat worker. Последний успешный проход не старше 12 минут означает `operational`; старый сигнал — `stale`; последний неуспешный проход, отсутствующая запись или ошибка чтения — `unavailable`. Время записи и проверки берётся из PostgreSQL, поэтому API и worker не спорят из-за рассинхронизации часов.

О первой ошибке пользователь получает уведомление. После 10 последовательных ошибок расписание автоматически отключается. `skipped` из-за overlap не увеличивает счётчик ошибок. История показывает `succeeded`, `failed` и `skipped`.

В аудит попадают управляющие метаданные действий, но не полный текст инструкции и расписания.

## 9. Главный редактор

Бот Главного редактора должен использовать только:

```text
http://editor-gateway:8080/ag-ui
```

Прямое подключение к `agent-codex:4202/ag-ui` обходит обязательный анализ и является ошибкой конфигурации. Gateway должен видеть `editor-analyzer` и `agent-codex`, а токены между сервисами должны совпадать.

Ожидаемый цикл редактора: принять исходный текст, получить проект исправления, проверить его анализатором, при необходимости повторить и вернуть исправленный текст. Текущий production профиль ограничивает число попыток, длительность и размер входа; ориентиры — до 3 попыток, 240 секунд и 512 KiB текста.

Для ссылки `https://docs.google.com/document/d/<id>/edit` редактор использует только выданный ему read-only grant `mcp__google-drive__read_google_document`. Документ читается через подключённый OAuth-аккаунт пользователя, служебная оболочка Google Docs отбрасывается, и проверка сравнивает правку с полным текстом документа, а не с цифрами из URL. Запись обратно в Google Docs не выполняется автоматически: для неё используется отдельная операция с точным диапазоном, `expectedText` и явным подтверждением.

Если у Бота нет grant чтения Google Docs, ссылка завершается контролируемой ошибкой с указанием требуемого доступа. Обычный текст по-прежнему обрабатывается штатным циклом.

Если редактор возвращает исходный текст без исправлений, сначала проверьте route выбранного Бота, затем здоровье analyzer и причины `accepted=false` в логах gateway. Увеличение числа повторов не исправляет неверный endpoint или несовместимое AG-UI тело.

## 10. Проверки перед выпуском

### Статические и тестовые проверки

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:ci
bun run build
```

Дополнительно выполните обязательный серверный quality gate:

```bash
/home/debian/server/tools/ai-quality/bin/ai-check
```

Не отключайте failing-check ради зелёного результата. Если ошибка относится к уже существующему baseline, зафиксируйте её отдельно от текущего изменения.

### Проверка production Compose

```bash
docker compose -f docker-compose.production.yml config --quiet
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d --wait
docker compose -f docker-compose.production.yml ps
curl --fail http://127.0.0.1:3021/health
bun run test:smoke
```

Проверяйте логи без вывода секретов, OAuth-токенов и полного пользовательского содержимого.

### Обязательный smoke-сценарий

1. Войти через production edge и убедиться, что origin нельзя открыть в обход аутентификации.
2. Отправить сообщение обычному Боту и увидеть несколько streaming chunks до финального ответа.
3. Сделать hard refresh и подтвердить восстановление истории из Intelligence.
4. Загрузить вложение, прочитать его через Бота, скачать и проверить запрет чужого actor/thread.
5. Создать все форматы артефактов, отдельно проверить PDF и безопасный preview HTML/SVG.
6. Подключить Google, выполнить read и по одной управляемой write-операции Docs/Sheets/Drive.
7. Импортировать Drive-файл в беседу и загрузить вложение беседы обратно в Drive.
8. Проверить карточки Google на правильный тип операции и безопасную ссылку.
9. Создать расписание разговором, запустить сейчас, увидеть результат и запись в истории.
10. Дождаться одного реального scheduled run через worker.
11. Отправить текст Главному редактору и подтвердить, что возвращён именно исправленный результат.
12. Проверить audit для grants, Google write, артефакта, вложения и расписания.

## 11. Диагностика сбоев

### `AG-UI вернул 400: Invalid request body`

Проверьте по порядку:

1. URL заканчивается на `/ag-ui` и ведёт к нужному runtime.
2. Главный редактор направлен в `editor-gateway`, а не напрямую в `agent-codex`.
3. Версии server/agent согласованы по AG-UI schema.
4. В server timing-логах есть `request_received`, `route_resolved` и `request_accepted`.
5. Если `request_accepted` отсутствует, проблема находится в теле запроса, схеме или ранней авторизации.
6. Если запрос принят, но агент не стартовал, проверяйте внутренний DNS, allowlist, токен и здоровье контейнера.

Не считайте SSE keep-alive доказательством выполнения. Полезный прогресс — текстовый chunk, tool event или финальное событие.

### Ответ завис или не начинается

- есть submit acknowledgement, но агент не получил запрос: проверить URL, DNS, allowlist и `MANAGED_AGENT_TOKEN`;
- агент принял запрос, но не создал run: проверить image/runtime auth и sandbox;
- зависание на первом tool: проверить tool callback URL, `AGENT_TOOL_TOKEN`, grant и policy;
- watchdog сработал на долгой операции: сравнить время последнего полезного event, а не общую длительность;
- история не появилась после refresh: проверить все Intelligence URL/key/license и сетевую доступность; локального fallback нет.

### Google OAuth или инструменты

- `redirect_uri_mismatch`: скопировать callback с `/admin/plugins/google-drive` и посимвольно сверить Google Console;
- `401` или протухший refresh token: переподключить аккаунт пользователя;
- `403`: проверить включённые API, scopes, права пользователя на файл и статус consent screen;
- инструмента нет у Бота: обновить каталог и выдать точный grant;
- `drive.file` не видит произвольный файл: файл должен быть создан приложением или явно выбран; широкое чтение требует `drive.readonly`;
- неизвестен исход мутации: сначала найти объект по idempotency marker, не повторять действие вслепую.

### Вложения и артефакты

- `404` при известном UUID: проверить actor/channel/thread и согласованность БД с attachment volume;
- PDF недоступен: проверить одновременно URL, token и health renderer;
- карточка не появилась: проверить точное имя first-party tool, версию результата и повторный authenticated metadata fetch;
- HTML/SVG показывается исходным текстом: это ожидаемая защита, а не ошибка renderer.

### Расписание не запускается

- убедиться, что `routine-worker` запущен;
- проверить индикатор worker на `/routines`: `stale` означает, что новых проходов давно не было, а `unavailable` — что успешный проход не подтверждён;
- сверить `WORKER_SHARED_SECRET` и `SERVER_INTERNAL_URL`;
- проверить 5-польный cron, IANA timezone и минимальный интервал;
- проверить, что routine не paused/disabled и нет активного пересекающегося run;
- помнить, что окна старше 10 минут специально пропускаются, а не воспроизводятся задним числом.

## 12. Rollout checklist

### До deployment

- [ ] Выбран единый production origin и выпущен TLS-сертификат.
- [ ] Edge-аутентификация закрывает origin; прямой обход проверен.
- [ ] Секреты созданы в secret manager и не попадают в rendered config/logs.
- [ ] Сделан согласованный backup PostgreSQL и attachment volume.
- [ ] Записаны immutable image IDs текущего и нового выпуска.
- [ ] Проверены права и ownership persistent volumes.
- [ ] При файловом backend вложений оставлена одна API-реплика.
- [ ] Google API включены, consent screen готов, origin/callback и scopes проверены.
- [ ] OAuth client connector введён через admin UI, а не записан в Git.
- [ ] Миграции проверены на копии production schema.
- [ ] Compose config, сборка, тесты и security/quality проверки завершены.

### Deployment

- [ ] Остановить или удержать `routine-worker`, чтобы он не запускал задачи во время миграции.
- [ ] Применить миграции ровно один раз.
- [ ] Развернуть согласованный комплект `openbot`, agent, editor, renderer и worker.
- [ ] Дождаться health всех обязательных сервисов.
- [ ] Выполнить полный smoke-сценарий.
- [ ] Возобновить worker и проверить один scheduled run.
- [ ] Проверить аудит, ошибки и задержки первого ответа.

### Откат

Если schema обратно совместима:

1. остановить worker;
2. вернуть предыдущие immutable images;
3. дождаться health;
4. выполнить smoke;
5. возобновить worker.

Если schema несовместима, остановите все writers и восстановите согласованный snapshot PostgreSQL вместе с attachment volume, используя тот же `KEY_ENCRYPTION_KEY`. Не выполняйте ручной откат SQL на живой БД без заранее проверенной процедуры.

`docker compose down -v` удаляет persistent volumes и не является штатной командой deployment или rollback.

## 13. Известные ограничения

- Контракты milestone остаются alpha и должны версионироваться вместе с server, app и agent runtime.
- CopilotKit Intelligence является жёсткой зависимостью долговременной истории.
- Файловый backend вложений рассчитан на одну API-реплику; горизонтальное масштабирование требует общего object storage.
- Экспорт артефакта из `workspacePath` ещё не реализован.
- HTML и SVG намеренно не рендерятся как активный документ.
- PDF требует отдельный изолированный renderer.
- Скачанный артефакт может стать активным при открытии вне TeamBot и остаётся недоверенным.
- Удалённому AG-UI агенту изображения не передаются байтами автоматически.
- Google restricted/sensitive scopes требуют consent и, для публичного приложения, проверки Google; `drive.file` не даёт широкого чтения всего Drive.
- Добавление Google-инструмента требует refresh каталога и явного grant; tenant skill не выдаёт capability.
- Расписания не выполняются без worker; старый backlog не воспроизводится.
- Создание расписания пока доступно только через разговор, а управление и история — только владельцу.
- Надёжность ответа зависит от доступности внешнего AG-UI runtime; keep-alive без protocol events не означает прогресс.
- Главный редактор работает корректно только через `editor-gateway`; прямой endpoint отключает анализ результата.
- В текущем приватном Compose worker token может быть совмещён с agent tool token; для независимой ротации их следует разделить.

## 14. Связанные документы

- [Production runtime](production-runtime.ru.md)
- [Production operations](production-operations.ru.md)
- [Attachments](attachments.md)
- [Artifacts](artifacts.md)
- [Routines](routines.md)
- [Google Drive plugin](plugins/google-drive.md)
- [Development](development.md)
- [Deployment](deployment.md)
