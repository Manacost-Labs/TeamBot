# Production runtime: топология, аутентификация и границы

Этот документ предназначен для разработчиков и дежурных инженеров частного production-развёртывания
OpenBot. Общие варианты установки описаны в [Deployment](deployment.md) и
[Helm chart](../charts/openbot/README.md); здесь зафиксированы границы конкретного контура из
`docker-compose.production.yml` и контракт выполнения диалога.

Ниже нет значений секретов. Не вставляйте в команды или тикеты содержимое `.env`, токены, cookies,
`auth.json`, тексты сообщений, аргументы инструментов или reasoning.

## Production-топология

В приватном Compose-контуре запрос проходит следующие узлы:

1. Nginx завершает TLS для `work-origin.kolodahearthstone.com`, проверяет сессию через
   `auth_request` и проксирует разрешённый запрос на loopback-порт `3021`.
2. `edge-auth` слушает loopback-порт `3030`, проверяет HMAC-сессию и отвечает Nginx кодом 204 или
   401. При истёкшей iframe-сессии Nginx показывает страницу безопасного повторного входа.
3. `openbot` публикует контейнерный порт 3001 только как `127.0.0.1:3021`. В одном контейнере
   работают API, собранное web-приложение, встроенный Chromium и, при `EMBEDDED_POSTGRES=on`,
   PostgreSQL.
4. Copilot runtime отправляет AG-UI-запрос в `agent-codex:4202/ag-ui`. Адрес доступен только в сети
   Compose и должен оставаться в `AGENT_ENDPOINT_ALLOWED_HOSTS`.
5. `agent-codex` запускает отдельный `codex app-server` для принятого запроса. Обратные вызовы
   разрешённых инструментов идут на `openbot:3001/api/agent-tools/call`.
6. `routine-worker` разделяет network namespace с `openbot`, читает пароль встроенной БД через
   read-only mount и запускает запланированные инструкции.
7. `editor-gateway` использует тот же AG-UI endpoint, но остаётся отдельным сервисом перед
   `editor-analyzer`. В production Compose для него заданы лимиты попыток, времени и размера текста.
8. `research-sources` — отдельный шлюз источников для research-профиля. Его ключи не должны попадать
   в AG-UI, журналы выполнения или workspace.

Постоянные данные разделены по владельцам:

| Данные | Владелец | Долговечность |
| --- | --- | --- |
| Каналы, политики, аудит, профили, grants | PostgreSQL OpenBot | volume `openbot-postgres` либо внешняя БД |
| История тредов и memory | CopilotKit Intelligence | внешний авторитетный сервис |
| Файлы общего computer | `/workspace` | volume `openbot-workspace` |
| Browser profile и активные логины | `/profiles` | volume `openbot-profiles` |
| Артефакты исследований | `/research-runs` | volume `research-runs` |
| Временный процесс Codex | контейнер `agent-codex` | не является хранилищем истории |

`docker compose down -v` удаляет volumes и поэтому не является штатной командой остановки или
rollback. Каталоги release, backup, cache, upload и runtime-копии также не являются исходниками.

## Два независимых слоя аутентификации

### Внешняя edge-сессия

`edge-auth` принимает только HMAC-токены, подписанные `OPENBOT_SESSION_SECRET` длиной не менее 32
символов. Bootstrap-токен обменивается на cookie `openbot_edge_session` со свойствами `HttpOnly`,
`Secure`, `SameSite=Lax` и сроком 8 часов. Nginx не передаёт тело запроса в `/_openbot_auth`.

Потеря cookie возвращает 401 и переводит всё окно, а не только iframe, на ChatGPT gateway. Проверяйте
внешний слой отдельно от OpenBot: успешный `/health` на loopback ещё не доказывает, что edge-сессия
браузера действительна.

### Сессия и роли OpenBot

Обычная поставка OpenBot поддерживает Google, Microsoft, Okta, зарегистрированные OIDC/SAML и режим
`OPENBOT_SINGLE_USER`. Полный контракт и обязательные пары переменных находятся в
[Configuration](configuration.md#authentication).

Частный Compose-контур устанавливает `OPENBOT_SINGLE_USER=true`: edge-шлюз решает, кто вообще
допущен к origin, а внутри OpenBot запрос выполняется как один администратор. Это осознанная
двухуровневая схема, а не замена edge-сессии приложением. Если включается identity provider OpenBot,
следует убрать single-user режим и заново проверить `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`,
`INITIAL_ADMIN_EMAILS` и callback URI.

### Аутентификация server → agent → tool callback

- `MANAGED_AGENT_TOKEN` предъявляется server-ом endpoint-у `agent-codex`. Пустой токен запрещает
  запуск agent-контейнера.
- `AGENT_TOOL_TOKEN` идентифицирует agent при callback к server-у.
- Подписанный `openbotRun` связывает callback с конкретными Bot, пользователем, `runId` и
  `threadId`. Общий токен без этой подписи не даёт тратить grants пользователя.
- При redirect на другой credential scope server удаляет авторизационные заголовки и подписанный
  run assertion. Проверка адреса выполняется на каждом redirect.

Эти значения являются bearer credentials. Их допустимо упоминать по имени, но не выводить.

## Кто владеет runtime-состоянием

Состояние одного запуска и доступность Bot — разные контракты.

- Авторитетный transcript хранится в CopilotKit Intelligence и читается через аутентифицированный
  server. In-memory cache хранит не более 12 тредов и хвост до 500 сообщений на тред, ключуется
  пользователем, тредом и Bot, очищается при выходе и всегда помечается stale до фоновой
  revalidation. Ошибка обновления показывается в канале; private reasoning не кэшируется.
- Глобальный browser lifecycle store ключуется `channelId + agentId`, а внутри записи хранит
  `logicalRunId`, монотонное поколение и до 12 известных protocol run ids. Новый логический run
  начинается явным переходом; событие старого поколения не может изменить новый run.
- Терминальный факт монотонен: completion, failure или cancellation не возвращаются в working из-за
  позднего starter/delta. Completion после unmount должен попасть в глобальный store.
- В `sessionStorage` сохраняются только до 32 минимальных, user-scoped lifecycle-записей: ids,
  статус и времена, но не transcript, draft, имя инструмента, ошибка или reasoning. После hard
  refresh активная запись сверяется с активным lock в Intelligence через
  `GET /api/threads/:threadId/execution?channelId=…&agentId=…` и с persisted history. Server сначала
  проверяет полный tuple пользователя, канала, треда и Bot. При активном lock монитор повторяет
  проверку каждые 2 секунды без произвольного срока завершения; после исчезновения lock использует
  задержки 0/250/750/1500/3000 мс, чтобы дождаться persisted answer. Ответ после соответствующего
  user turn завершает run, а failure выводится только после успешного отрицательного ответа обоих
  источников. Если один источник недоступен, UI показывает восстановление соединения и продолжает
  контролируемые повторы.
- Availability канала/Bot и runtime connectivity не выводятся из статуса последнего run. Последний
  результат остаётся видимым, даже когда Bot временно недоступен.

Draft, позиция прокрутки и окно transcript хранятся отдельно в 12-entry in-memory LRU и не являются
runtime truth. Transcript монтирует последние 60 строк; раскрытие старых строк сохраняет scroll
anchor. Hover/focus по каналу запускает дедуплицированный prefetch, но отправка сообщения никогда не
ждёт history: она ждёт только ограниченный join runtime.

## AG-UI streaming

`agent-codex` переводит только реальные события Codex:

- `RUN_STARTED` открывает run;
- `TEXT_MESSAGE_CONTENT` передаёт исходный progressive delta без синтетической печати;
- `TOOL_CALL_*` передаёт вызов и результат авторизованному клиенту;
- `RUN_FINISHED` либо `RUN_ERROR` закрывает run ровно один раз;
- SSE-комментарий `: keep-alive` каждые 30 секунд поддерживает транспорт и не является AG-UI
  событием, сообщением или доказательством прогресса.

Видимый reasoning — только официальный краткий summary и только для профиля, где
`shouldExposeReasoning` это разрешает. Research-run не показывает reasoning summaries; безопасный
прогресс должен идти обычным текстом или tool events. Private chain-of-thought не сохраняется, не
рендерится и не логируется.

Отключение браузера завершает доставку через `SafeStreamWriter`, но уже запущенная maintenance-задача
может продолжить работу. Поэтому `stream_cancelled` в timing-журнале не равен отмене дочернего
процесса и может предшествовать `run_completed`.

## Профили прав `agent-codex`

Профиль выбирается server-owned идентификатором Bot и набором выданных deployment tools. Базовые
правила находятся в `agent-codex/config.toml`:

| Профиль | Filesystem | Network | Назначение |
| --- | --- | --- | --- |
| `openbot-agent` | workspace roots только read | off | обычный приватный помощник; только динамические OpenBot tools |
| `data-control-agent` | write в `/workspace` и его `.git` | off | минимальный ремонт выделенного parser clone |
| `heartpulse-control-agent` | write в `/workspace` и `/workspace-heartpulse`, включая `.git` | off | end-to-end ремонт HeartPulse clone |
| `research-agent` | source workspaces read; `/research-runs` write | on | сбор источников и изолированные отчёты |

Для всех профилей `~/.codex` закрыт. Контейнер монтирует host `auth.json`, потому что сам
`codex app-server` должен аутентифицироваться, но model-facing filesystem profile не должен его
читать. `agent-codex` работает как пользователь `bun`, не root.

Production Compose ослабляет внешний seccomp/AppArmor и добавляет capabilities, необходимые
`bubblewrap`. Это не выдача прав модели: внутренний Codex sandbox остаётся обязательной границей.
Если `bwrap` не стартует, нельзя «починить» это отключением профиля или разрешением `~/.codex`;
исправляется совместимость host/container sandbox.

## Workspace и editor

- `/workspace` в `agent-codex` — выделенный source clone для data-control, а не production runtime.
- `/workspace-heartpulse` — отдельный HeartPulse worktree. Изменения production-путей запрещены.
- `/workspace-research` монтируется read-only; результат пишется только в `/research-runs`.
- Общий `/workspace` контейнера `openbot` принадлежит computer и сохраняется отдельным volume. Это
  другая граница, несмотря на одинаковое имя каталога внутри разных контейнеров.
- `editor-gateway` ограничивает один запрос параметрами `EDITOR_MAX_ATTEMPTS=3`,
  `EDITOR_TIMEOUT_SEC=240` и `EDITOR_MAX_TEXT_BYTES=524288`, а анализатор вынесен в отдельный сервис.
  Editor не получает обход sandbox: итоговый AG-UI run всё равно проходит профиль `agent-codex`.

### Контракт «Главного редактора»

Production endpoint редактора — `http://editor-gateway:8080/ag-ui`; прямой
`http://agent-codex:4202/ag-ui` обходит редакторскую валидацию и для этой роли не используется.
`EDITOR_AGUI_TOKEN` — исходящий credential gateway → agent-codex в заголовке
`X-OpenBot-Agent-Token`. Необязательный `EDITOR_AGENT_TOKEN` защищает входящий `/ag-ui` редактора
через Bearer; в текущем приватном Compose он не задан, поэтому вход ограничивается сетью Compose и
allowlist server-а. Это разные направления аутентификации, один токен не следует считать заменой
другого.

Редактор буферизует кандидат до завершения проверки качества и только затем выдаёт один принятый
content event; SSE keep-alive поддерживает соединение, но не является текстом ответа. `accepted=false`
означает, что валидатор отклонил правку: gateway обязан вернуть исходный текст и причины отклонения,
а не выдавать молчаливое «исправление». Для коротких текстов проверки article-level rhythm не
применяются до 15 предложений; сокращение отклоняется только при потере более 5% и не менее восьми
слов либо при потере не менее половины короткого текста.

Заявленные в Git профили `openbot-agent`, `data-control-agent`, `heartpulse-control-agent` и
`research-agent` — единственный документированный roster прав. Data-control может исправлять только
выделенный parser clone и проходит его publish verification. HeartPulse имеет отдельный writable
worktree, но автоматический production rollback для него не заявлен: rollback выполняется по
соответствующему runbook, а не предполагается из названия профиля.

Любой новый bind mount расширяет фактическую доступность данных и требует отдельного review. Нельзя
монтировать `.env`, production database dump, host home или каталог секретов в model workspace.

## Инварианты безопасности

1. Исходники меняются в source repository/worktree, deployment выполняется штатным способом.
2. Tool action проходит server gateway: resolve → policy → audit row → action/refusal.
3. Timing-журнал содержит только идентификаторы и длительности; аудит инструмента — отдельный поток.
4. Transcript и tool payload не являются телеметрией производительности.
5. Ни availability, ни terminal status не синтезируются таймером.
6. Browser cache не становится вторым долговечным источником transcript.
7. Секреты не попадают в URL, командные аргументы, Git, журналы или документы.

Операционные процедуры, timing-фазы и диагностика описаны в
[Production operations](production-operations.ru.md).
