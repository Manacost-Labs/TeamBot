# Production operations: deployment, rollback и timing-диагностика

Этот runbook относится к runtime из [Production runtime](production-runtime.ru.md). Команды не
выводят значения секретов. Перед выполнением задайте один явный путь к Compose-файлу и не подменяйте
системные переменные вроде `HOME`:

```sh
COMPOSE_FILE=docker-compose.production.yml
```

Все операции выполняются из source repository. Не редактируйте `/var/www`, container filesystem,
release-копии или volumes как исходный код.

## Предварительная проверка

1. Зафиксируйте текущий commit, image digest/id и состояние сервисов в change ticket. Не вставляйте
   вывод environment.
2. Убедитесь, что рабочее дерево содержит только ожидаемые изменения.
3. Проверьте конфигурацию без печати развёрнутого YAML:

   ```sh
   docker compose -f "$COMPOSE_FILE" config --quiet
   ```

   Проверьте, что `openbot` имеет `EMBEDDED_COMPUTER=off`, зависит от healthy `agent-computer` и
   один монтирует `openbot-attachments:/var/lib/openbot/attachments`. У `agent-computer` должны быть
   только `openbot-workspace` и `openbot-profiles`; volume вложений ему не передаётся.

4. Для изменения исходников выполните quality gates:

   ```sh
   bun run format:check
   bun run lint
   bun run typecheck
   bun run test:ci
   bun run build
   ```

5. Перед изменением схемы сделайте проверяемый backup/snapshot. Миграции OpenBot не имеют
   автоматического down-пути.

Для release image используйте digest из `container-images.json`, а не moving tag. Проверка
provenance и скачивание manifest описаны в [Releasing](releasing.md#deploying-a-release).

## Backup

Для внешней PostgreSQL используйте provider snapshot/PITR и отдельно проверьте восстановление. Для
embedded PostgreSQL Compose можно получить custom-format dump, не печатая пароль:

```sh
docker compose -f "$COMPOSE_FILE" stop routine-worker
docker compose -f "$COMPOSE_FILE" exec -T openbot sh -eu -c '
  PGPASSWORD="$(cat /var/lib/postgresql/pgpassword)" \
    pg_dump -h 127.0.0.1 -U openbot -Fc openbot
' > /secure/backup/openbot-before-deploy.dump
docker compose -f "$COMPOSE_FILE" start routine-worker
```

Путь `/secure/backup` — пример: выберите каталог с контролем доступа и политикой retention. Проверьте,
что файл ненулевой, и выполните тестовое восстановление в отдельную БД. Не добавляйте dump в Git.

Attachment bytes, workspace, browser profiles и research reports не входят в database dump. Если
изменение затрагивает их формат, сделайте согласованный snapshot volumes `openbot-attachments`,
`openbot-workspace`, `openbot-profiles` и `research-runs`. Метаданные вложений в PostgreSQL и bytes
из `openbot-attachments` должны восстанавливаться из одной согласованной точки. Не используйте
`docker compose down -v`.

## Deployment в приватном Compose-контуре

### Ключи источников главного аналитика

Три provider key, доступные аналитику через отдельный `research-sources` gateway, задаются
интерактивно. Значения не отображаются и атомарно записываются только в игнорируемый Git файл
`.env` с правами `0600`:

```sh
cd /srv/projects/web/work.kolodahearthstone.com
./scripts/configure-research-secrets.sh
```

Helper запрашивает `RESEARCH_REDDITAPIS_KEY`, `RESEARCH_GETXAPI_KEY` и
`RESEARCH_TINYFISH_API_KEY`. Первый-party `stats-api` использует разрешённые read-only endpoints и
отдельного ключа не требует. После ротации пересоздайте `research-sources` и `agent-codex`; не
передавайте provider keys непосредственно в model-facing контейнер.

Сначала соберите образы, затем замените сервисы и дождитесь health checks:

```sh
docker compose -f "$COMPOSE_FILE" build
docker compose -f "$COMPOSE_FILE" up -d --wait
docker compose -f "$COMPOSE_FILE" ps
curl -fsS http://127.0.0.1:3021/health >/dev/null
curl -fsS http://127.0.0.1:3030/health >/dev/null
docker compose -f "$COMPOSE_FILE" exec -T agent-codex \
  bun -e "const r=await fetch('http://127.0.0.1:4202/health');process.exit(r.ok?0:1)"
docker compose -f "$COMPOSE_FILE" exec -T agent-computer \
  bun -e "const r=await fetch('http://127.0.0.1:4100/health');process.exit(r.ok?0:1)"
```

После health checks выполните один реальный test-run без чувствительного текста и найдите его
timing-последовательность по `runId`. Затем проверьте:

- браузер проходит edge-login и загружает канал;
- существующий transcript восстанавливается из server/Intelligence;
- новый ответ приходит progressive deltas;
- один разрешённый tool проходит gateway и появляется в audit;
- error/cancel не оставляет lifecycle в бесконечном working;
- routine-worker не перезапускается и снова обрабатывает schedule.

Контейнерный `/health` подтверждает, что процесс отвечает, но не доказывает действительность
CopilotKit license, внешний model endpoint, callback tools или browser login.

## Kubernetes

Chart запускает migration как `pre-install,pre-upgrade` Job. Для Helm 3 используйте атомарный
upgrade:

```sh
helm upgrade --install openbot charts/openbot \
  --namespace openbot --create-namespace \
  --atomic --values /secure/openbot-values.yaml
```

Helm 4 называет соответствующий upgrade-флаг `--rollback-on-failure`; `--atomic` пока принимается как
deprecated alias. Не используйте `--reuse-values` без проверки новых chart defaults: новый ключ может
отсутствовать в ранее вычисленных values. До upgrade выполните `helm template` с теми же values и
проверьте Job миграции, Secret keys и NetworkPolicy.

## Rollback

Rollback всегда возвращает согласованный набор server + agent + editor, а не один случайный
контейнер.

### Только код/образ, совместимая схема

1. Остановите автоматические routine-запуски.
2. Верните ранее зафиксированные immutable image digests/ids для всех изменённых сервисов.
3. Выполните `docker compose ... up -d --wait` либо `helm rollback <release> <revision> --wait`.
4. Повторите health, transcript, AG-UI, tool callback и timing smoke checks.
5. Возобновите routine-worker только после проверки.

Для опубликованного OpenBot release rollback — это запуск digest из более раннего
`container-images.json`, как указано в [Releasing](releasing.md). Для локально собранного
`agent-codex` заранее сохраните image id/tag: повторный `docker compose build` сам по себе не создаёт
immutable release manifest.

### Несовместимая миграция или данные

Не пытайтесь «откатить» SQL вручную на обслуживающей трафик БД. Остановите writers, восстановите
проверенный snapshot/dump в изолированную БД, проверьте её старым образом, затем переключите
`DATABASE_URL` по change-процедуре. Stored credentials зашифрованы `KEY_ENCRYPTION_KEY`; потеря или
замена ключа делает backup неполным. Rollback приложения без совместимого ключа и данных не является
rollback.

## Формат timing-журнала

Каждая строка — JSON с фиксированными полями:

```json
{
  "type": "execution-timing",
  "component": "agent-codex",
  "phase": "first_text_delta",
  "requestId": "...",
  "runId": "...",
  "threadId": "...",
  "agentId": "...",
  "elapsedMs": 123.456
}
```

Допускаются только `status` для server response и `errorType` для ошибки. Сообщения, deltas,
reasoning, tool names/arguments/results, credentials и stack traces в timing record отсутствуют.

`requestId` относится к одному HTTP hop и может различаться между browser → server и server →
agent. Сквозное объединение выполняется по `runId`, `threadId`, `agentId`; сравнивать абсолютные
монотонные часы разных процессов нельзя.

## Фазы server-runtime

| Фаза | Что уже произошло | Как читать задержку |
| --- | --- | --- |
| `request_received` | Copilot handler принял подходящий `/agent/.../run` или `/connect`; старт равен 0 | Не включает Nginx, edge-auth и outer app middleware |
| `route_resolved` | CopilotKit выбрал handler `agent/run` или `agent/connect` | Не доказывает валидность JSON; итог parse/validation виден по status ack/error |
| `request_accepted` | Клонированное тело прошло публичную AG-UI schema после выбора route | Отсутствует у malformed/невалидного input; исходный stream тела не потребляется |
| `submit_ack` | handler run вернул response/stream с HTTP status | Это ack транспорта, а не завершение model run |
| `connect_ack` | connect handler вернул response | Диагностика runtime connection, отдельно от последнего run |
| `request_error` | runtime handler выбросил ошибку | `errorType` содержит только класс ошибки |

Server пытается прочитать из клона body только allowlisted IDs; malformed JSON не мешает записать
`request_received` и `route_resolved`, но не получает корреляционные IDs и
`request_accepted`. Его `elapsedMs=0`
соответствует моменту входа в hook. Фактический отказ parse/validation отражается status в
`submit_ack`/`connect_ack` либо `request_error`.

## Фазы agent-codex

| Фаза | Граница |
| --- | --- |
| `request_received` | Авторизованный HTTP fetch вошёл в `/ag-ui`; elapsed стартует до body parse |
| `request_accepted` | managed token принят и AG-UI input разобран |
| `run_started` | отправлен реальный `RUN_STARTED` |
| `child_process_spawned` | ОС подтвердила успешный запуск `codex app-server` событием `spawn` |
| `codex_initialized` | получен ответ `initialize`, отправлен `initialized` |
| `codex_thread_started` | `thread/start` вернул Codex thread id |
| `codex_turn_started` | `turn/start` подтверждён Codex app-server |
| `first_reasoning` | получен первый разрешённый safe summary; private reasoning сюда не попадает |
| `first_tool` | получен первый tool call; identity и arguments не логируются |
| `first_text_delta` | передан первый исходный `TEXT_MESSAGE_CONTENT` delta |
| `stream_cancelled` | потребитель SSE отключился; background maintenance может продолжаться |
| `run_completed` | отправлен один `RUN_FINISHED` |
| `run_error` | отправлен один `RUN_ERROR`; лог содержит только `errorType` |

Каждая фаза записывается не более одного раза на request. В run без reasoning/tool соответствующей
фазы нет — её нельзя синтезировать. В run с несколькими tools фиксируется только первый tool
milestone, а полный факт действий находится в audit/AG-UI, не в performance log.

## Извлечение последовательности

Для Compose выводите только JSON-записи нужного типа:

```sh
docker compose -f "$COMPOSE_FILE" logs --no-color --no-log-prefix openbot agent-codex \
  | jq -R 'fromjson? | select(.type == "execution-timing")'
```

По известному run:

```sh
RUN_ID=run-id-from-safe-test
docker compose -f "$COMPOSE_FILE" logs --no-color --no-log-prefix openbot agent-codex \
  | jq -R --arg run "$RUN_ID" \
      'fromjson? | select(.type == "execution-timing" and .runId == $run)'
```

Не подставляйте в `RUN_ID` пользовательский текст. Docker timestamp полезен для порядка между
контейнерами; `elapsedMs` используется только внутри одного component/request.

## Диагностические сценарии

### Есть `submit_ack`, но нет agent `request_received`

Проверьте выбранный agent endpoint, DNS сети Compose, `AGENT_ENDPOINT_ALLOWED_HOSTS`, health
`agent-codex`, redirect policy и stall guard. `submit_ack` означает, что server принял transport, но
не доказывает, что remote agent начал run.

### Есть `request_accepted`, но нет `child_process_spawned`

Ошибка находится до/во время создания Codex child. Проверьте наличие `codex` в image, права
пользователя `bun`, container restart и sandbox prerequisites. Не выводите `auth.json`.

### Большой интервал spawn → initialized

Проверяйте состояние Codex app-server, доступ к его собственной авторизации и saturation host.
Модельный first-token ещё не начался: endpoint/tool не являются первой гипотезой.

### Большой интервал initialized → thread/turn

Проверяйте workspace mount и выбранный permission profile. Ошибка доступа к каталогу должна
исправляться mount/profile-конфигурацией, а не выдачей широких прав или чтением credential path.

### `codex_turn_started` есть, first event долго отсутствует

Model turn принят. Сравните, появляется ли первым `first_reasoning`, `first_tool` или
`first_text_delta`; затем проверяйте model/provider и реальный tool dependency. SSE keep-alive не
считается прогрессом. Если срабатывает `agent-stream-stalled`, используйте его `run/thread` для
сопоставления.

### `first_tool` есть, текста нет

Найдите tool callback в audit, проверьте policy/refusal и результат. Timing намеренно не называет
tool и не заменяет audit. Несколько tools не создают несколько `first_tool` записей.

### Есть `stream_cancelled`, затем `run_completed`

Это допустимо для maintenance run: клиент ушёл, доставка стала no-op, процесс закончил работу. Для
обычного диалога проверьте proxy timeout, browser navigation/reload и reconnect/reconciliation. Не
объявляйте run ошибочным только по `stream_cancelled`.

### Есть `run_error`

Сопоставьте `errorType`, component и последнюю достигнутую фазу. Подробность ищите в безопасном
операционном error log и audit, но не добавляйте error message/body в timing schema.

## Проверка после изменения runtime

Минимальный набор:

```sh
bun test server/tests/copilot.test.ts server/tests/copilot-telemetry.test.ts \
  agent-codex/tests/codex-run.test.ts agent-codex/tests/execution-timing.test.ts
bun run --filter server typecheck
bun run --cwd agent-codex test
```

Проверка должна подтвердить:

- порядок spawn/init/thread/turn;
- once-only first reasoning/tool/text;
- text-only, tool-first, completion, error и delivery-cancel;
- исходные progressive `TEXT_MESSAGE_CONTENT` deltas и один terminal AG-UI event;
- отсутствие prompt, delta, reasoning, tool payload и credentials в сериализованных records;
- ссылки на оба русских runbook из `docs/README.md`;
- общий `format:check`, `lint`, `typecheck`, `test:ci`, `build`, `ai-check` и security check.

## Проверка целевых задержек интерфейса

Целевые значения являются release gate, а не утверждением о любом устройстве: показ канала из
тёплого cache — менее 100 мс, первый полезный экран без cache — менее 300 мс, оптимистичное user
сообщение — менее 100 мс после submit, обновление lifecycle после принятого AG-UI event — менее
500 мс. Проверяйте их на production-подобном build без DevTools throttling минимум на 30 переходах
каждого типа; фиксируйте p50/p95, commit, браузер и профиль устройства.

Browser Performance marks измеряют submit → paint и navigation → первый transcript paint. Server и
agent timing из этого runbook измеряют request/agent часть, но не DOM paint. Не подменяйте измерение
таймером, который рисует искусственный progress: deterministic тесты 50/200/500 сообщений, render
counts и A→B→A защищают архитектуру, а wall-clock замер подтверждает целевую задержку конкретной
сборки. Если цель не достигнута, релизный отчёт должен назвать фактический p95 и bottleneck, а не
скрывать его увеличением timeout.

Канонический локальный browser gate запускается командой `bun scripts/runtime-performance.ts`. Он
собирает minified production fixture с настоящим transcript, выполняет в Chromium по 30 warm/cold,
first-delta и 50/200/500 rich-history измерений и падает при превышении p95. Последняя зафиксированная
методика и результаты находятся в [`runtime-performance-evidence.ru.md`](runtime-performance-evidence.ru.md).
Машиночитаемый content-free снимок хранится в
[`runtime-performance-evidence.json`](runtime-performance-evidence.json).
Этот gate исключает auth/provider/network latency и поэтому дополняет, а не заменяет production
telemetry ниже.

Браузер отправляет эти DOM-границы автоматически небольшими batches на
`POST /api/telemetry/workspace`. Тело содержит только operation, allowlisted phase, случайный UUID
trace и монотонный `elapsedMs`; channel/user/message IDs и содержимое переписки не отправляются.
Администратор получает текущие rolling p50/p95/p99 через
`GET /api/telemetry/workspace/summary`. Сводка хранит последние 512 значений каждой пары
operation/phase в памяти процесса и обнуляется при restart; это оперативная диагностика, а не
долговременное хранилище метрик.

Для переключения канала доступны `channel_click`, `cached_history_painted`,
`fresh_history_loaded`, `runtime_ready`, `runtime_joined`, `composer_ready`; для ответа —
`first_text_painted`. Paint-фазы проходят реальную browser paint boundary. Прямое открытие URL не
имеет `channel_click` и потому не подменяется искусственным нулевым измерением.

## Известные ограничения

- Это structured logs, а не OpenTelemetry trace или histogram. Percentiles/alerts строятся внешним
  log backend; high-cardinality IDs нельзя превращать в metric labels.
- Монотонное время обнуляется на process restart и не сравнивается между контейнерами.
- В timing нет wall-clock timestamp; его добавляет container/log collector.
- Неуспешная авторизация и невалидный JSON могут завершиться до полной корреляции.
- `first_reasoning` означает только разрешённый summary и отсутствует у research-run по дизайну.
- `stream_cancelled` не прерывает maintenance process.
- Server `submit_ack` не является end-to-end completion.
- Runtime log не заменяет audit, health checks, transcript storage и external provider monitoring.
