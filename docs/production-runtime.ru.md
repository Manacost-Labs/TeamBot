# Production runtime: топология, аутентификация и границы

Этот документ предназначен для разработчиков и дежурных инженеров частного production-развёртывания
ManacostTeam. Общие варианты установки описаны в [Deployment](deployment.md) и
[Helm chart](../charts/openbot/README.md); здесь зафиксированы границы текущего source release из
`docker-compose.production.yml` и контракт выполнения диалога.

Source release уже подготовлен для Telegram-сессий и личных AI-подключений, но Tasks 1–31 не
переключают production traffic. До отдельно одобренных Tasks 32–34 действующий public gateway и
`work-origin.kolodahearthstone.com` остаются legacy rollback-контуром. Порядок перехода описан в
[runbook аутентификации ManacostTeam](runbooks/manacostteam-authentication.md).

Ниже нет значений секретов. Не вставляйте в команды или тикеты содержимое `.env`, токены, cookies,
`auth.json`, тексты сообщений, аргументы инструментов или reasoning.

## Production-топология

В подготовленном приватном Compose-контуре запрос проходит следующие узлы:

1. Пока public cutover не одобрен, tracked Nginx-конфигурация
   `ops/nginx/work-origin.kolodahearthstone.com.conf` продолжает проверять legacy edge-сессию через
   `auth_request` и проксирует разрешённый запрос на loopback-порт `3021`.
2. `edge-auth` слушает loopback-порт `3030` и сохранён для действующего gateway и полного rollback.
   Он не определяет ManacostTeam actor в новом release и удаляется из live dependency только во
   время отдельно одобренного public cutover.
3. `openbot` публикует контейнерный порт 3001 только как `127.0.0.1:3021`. В нём работают API,
   собранное web-приложение, Telegram/Better Auth session boundary и, при
   `EMBEDDED_POSTGRES=on`, PostgreSQL. Computer внутри API явно выключен через
   `EMBEDDED_COMPUTER=off`.
4. `agent-computer` запускается из того же image отдельным non-root процессом, получает только
   `COMPUTER_TOKEN`, `/workspace` и `/profiles`, но не volume вложений. API обращается к нему по
   `http://agent-computer:4100` только после успешного health check.
5. Copilot runtime отправляет AG-UI-запрос в `agent-codex:4202/ag-ui`. Адрес доступен только в сети
   Compose и должен оставаться в `AGENT_ENDPOINT_ALLOWED_HOSTS`.
6. `agent-codex` получает одноразовую actor/run-bound credential lease и запускает отдельный
   `codex app-server` с личным ChatGPT profile либо фиксированным OpenRouter provider. Обратные
   вызовы разрешённых инструментов идут на `openbot:3001/api/agent-tools/call`.
7. `routine-worker` разделяет network namespace с `openbot`, читает пароль встроенной БД через
   read-only mount и запускает запланированные инструкции.
8. `editor-gateway` использует тот же AG-UI endpoint, но остаётся отдельным сервисом перед
   `editor-analyzer`. В production Compose для него заданы лимиты попыток, времени и размера текста.
9. `research-sources` — отдельный шлюз источников для research-профиля. Его ключи не должны попадать
   в AG-UI, журналы выполнения или workspace.

Постоянные данные разделены по владельцам:

| Данные | Владелец | Долговечность |
| --- | --- | --- |
| Каналы, политики, аудит, профили, grants | PostgreSQL OpenBot | volume `openbot-postgres` либо внешняя БД |
| История тредов и memory | CopilotKit Intelligence | внешний авторитетный сервис |
| Приватные bytes вложений | `/var/lib/openbot/attachments` | volume `openbot-attachments`; метаданные отдельно в PostgreSQL |
| Файлы общего computer | `/workspace` | volume `openbot-workspace` |
| Browser profile и активные логины | `/profiles` | volume `openbot-profiles` |
| Артефакты исследований | `/research-runs` | volume `research-runs` |
| Личные AI connections | PostgreSQL + credential vault | ciphertext; привязан к внутреннему user ID |
| Временный процесс Codex | tmpfs `/run/openbot-codex` в `agent-codex` | отдельный `CODEX_HOME` на run, удаляется после процесса |

`docker compose down -v` удаляет volumes и поэтому не является штатной командой остановки или
rollback. Каталоги release, backup, cache, upload и runtime-копии также не являются исходниками.

## Независимые границы аутентификации

### Legacy edge-сессия до public cutover

`edge-auth` принимает только HMAC-токены, подписанные `OPENBOT_SESSION_SECRET` длиной не менее 32
символов. Bootstrap-токен обменивается на cookie `openbot_edge_session` со свойствами `HttpOnly`,
`Secure`, `SameSite=Lax` и сроком 8 часов. Nginx не передаёт тело запроса в `/_openbot_auth`.

Потеря cookie возвращает 401 и переводит всё окно, а не только iframe, на ChatGPT gateway. Это
состояние действующего public route, а не новый способ идентифицировать ManacostTeam user. Успешный
`/health` на loopback ещё не доказывает ни legacy edge-сессию, ни Telegram login.

### Telegram-сессия и роли ManacostTeam

Telegram callback проверяется server-side: подпись, freshness, одноразовое browser-bound state и
membership числового ID в allowlist. После этого Better Auth создаёт обычную database-backed
сессию. Owner ID получает существующую роль `admin`, остальные allowlisted ID — `user` (редактор).
Username, имя и avatar не являются authorization input.

Current Compose выставляет `OPENBOT_SINGLE_USER=false` по умолчанию. Если старый `.env` пытается
вернуть `OPENBOT_SINGLE_USER=true`, Telegram configuration отказывается стартовать. Удаление ID из
allowlist прекращает новые входы и при startup reconciliation удаляет его сессии; explicit Remove в
`/admin/people` создаёт sticky revoke и также отзывает личные credentials.

### Личное AI-подключение

Telegram отвечает на вопрос «кто вошёл», а Settings `/settings` — «каким личным provider выполняются
его Codex runs». Пользователь выбирает один вариант: ChatGPT/Codex device login либо write-only
OpenRouter API key. Смена provider атомарно заменяет предыдущий credential после успешной проверки;
disconnect запрещает новые и queued runs, но не удаляет историю.

Browser никогда не получает сохранённый key или auth document. У пользователя без active
connection нет fallback на owner connection, host profile или общий deployment model key.

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

Для всех model-facing профилей обычный home и чужие runtime profiles закрыты. Host `auth.json` и
общий OpenRouter key в контейнер не монтируются. Server выдаёт только matching actor/run credential:
ChatGPT auth document материализуется в mode-`0700` run-owned `CODEX_HOME`, а OpenRouter key
доставляется по одноразовой lease и исключается из shell/tool environment. Весь runtime root
`/run/openbot-codex` находится на tmpfs; `agent-codex` работает как пользователь `bun`, не root.

Production Compose ослабляет внешний seccomp/AppArmor и добавляет capabilities, необходимые
`bubblewrap`. Это не выдача прав модели: внутренний Codex sandbox остаётся обязательной границей.
Если `bwrap` не стартует, нельзя «починить» это отключением профиля или разрешением `~/.codex`;
исправляется совместимость host/container sandbox.

## Workspace и editor

- `/workspace` в `agent-codex` — выделенный source clone для data-control, а не production runtime.
- `/workspace-heartpulse` — отдельный HeartPulse worktree. Изменения production-путей запрещены.
- `/workspace-research` монтируется read-only; результат пишется только в `/research-runs`.
- `/workspace` и `/profiles` монтируются только в отдельный `agent-computer`. В `openbot` этих
  mounts нет; только API получает `openbot-attachments` по фиксированному пути
  `/var/lib/openbot/attachments`. Поэтому shell/browser computer не может прочитать вложения через
  общий процесс или volume.
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
8. Telegram app session и personal AI connection никогда не подменяют друг друга.

Операционные процедуры, timing-фазы и диагностика описаны в
[Production operations](production-operations.ru.md); protected setup, owner/editor access,
personal providers и cutover — в
[ManacostTeam authentication](runbooks/manacostteam-authentication.md).
