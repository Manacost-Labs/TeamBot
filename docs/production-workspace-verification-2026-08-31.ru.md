# Проверка TeamBot Production Workspace — 2026-08-31

Этот отчёт фиксирует проверяемое состояние milestone из
`TeamBot_Production_Workspace_Prompt.md`. Он разделяет доказанное поведение кода, production smoke
и действия, которые нельзя подтвердить без пользовательского Google OAuth.

## Результат выпуска

- Ветка: `main`.
- Проверенный commit приложения: `6921c53`.
- Production image: `sha256:839cd6141252441b2f3cb10c4566324f9fbf5b9313bb2680f3a67925600031df`.
- Точка отката: `openbot-work:rollback-20260831-before-6921c53`.
- `openbot`, `routine-worker` и `agent-computer`: `healthy`, restart count `0`.
- Локальный `/health`: `{"status":"ok"}`.
- Публичный origin возвращает ожидаемый `401 Sign in required`; origin не открыт в обход edge-auth.
- После выпуска две пришедшие по времени routine были выполнены; незавершённых запусков `0`,
  последний heartbeat worker имел статус `succeeded`.

## Definition of done

| № | Требование | Статус и доказательство |
|---:|---|---|
| 1–5 | Быстрое переключение, стабильная история, конкурентные сотрудники, корректный run state, progressive streaming | Выполнено. Runtime/store/integration tests зелёные; Chromium gate проверяет progressive delta и переключения. |
| 6–9 | Загрузка файлов и изображений, governed attachment access, семь форматов артефактов, chat cards | Выполнено. Persistence, authorization, upload lifecycle, sanitization, renderer и artifact card tests входят в полный suite. |
| 10 | Пользователь подключает Google через OAuth | Реализовано и задокументировано. Живой production E2E ожидает подключения пользователя: сейчас `google_user_connections=0`. |
| 11–13 | Drive read/search, Docs read/write, Sheets read/write | Реализовано; REST/OAuth boundary и интеграционные тесты зелёные. Живой вызов Google API ожидает пользовательского OAuth. |
| 14 | Google writes проходят authorization, grant, policy и безопасный audit | Выполнено. Негативные сценарии покрывают missing/expired OAuth, revoked/read-only grant, policy deny и отсутствие содержимого в audit. |
| 15–16 | Attachment → Drive и Google file → TeamBot Attachment | Реализовано и покрыто contract/integration tests; живой vendor E2E ожидает OAuth. |
| 17–18 | Обычная настройка сотрудника без YAML; model/reasoning/skills/tools/Google grants | Выполнено. Добавлены восемь шаблонов, avatar seed, reasoning ceiling и Adaptive с серверным ограничением. |
| 19 | Расписание создаётся разговорно и редактируется визуально | Выполнено. В форме доступны employee, target channel, timezone, enabled и все overlap policy. |
| 20 | Scheduled Docs/Sheets работают безопасно | Выполнено на реальном routine runner с подменой только vendor/OAuth boundary. Живой Google E2E ожидает OAuth. |
| 21 | Видимое здоровье worker | Выполнено; production heartbeat после выпуска `succeeded`. |
| 22–23 | p50/p95 и отзывчивость длинной истории | Выполнено. Chromium, 30 измерений на сценарий: warm p95 33,9 ms, cold p95 35,7 ms, history 50/200/500 p95 30,6/31,5/33,6 ms. Подробности: [Runtime performance evidence](runtime-performance-evidence.ru.md). |
| 24 | Security tests для attachments и Google Workspace | Выполнено. Gitleaks не нашёл утечек; полный suite и специальные Google security scenarios зелёные. |
| 25 | Фокусированные Git commits | Выполнено: изменения разделены на feature, test, perf и docs commits. |

## Запущенные gates

- `bun run format:check` — успешно, 663 файла.
- `bun run lint` — успешно, 667 файлов.
- `bun run typecheck` — успешно во всех workspace.
- `bun run test:ci` — успешно с PostgreSQL/pgvector test boundary.
- `bun run build` — успешно; остаются только предупреждения Vite о крупных chunks.
- `ai-check` — проектные gates прошли, общий скрипт завершился на существующем baseline `shfmt`
  в старых shell-файлах. Массовое форматирование не включалось в этот выпуск.
- `ai-security-check` — утечек секретов нет; dependency scan сообщает 31 известное
  предупреждение (0 Critical, 12 High, 16 Medium, 3 Low), существовавших вне dependency scope
  этого выпуска. Обновление зависимостей должно идти отдельной проверяемой задачей.

## Последний внешний шаг Google

1. В Google Auth Platform открыть **Audience**.
2. Пока приложение в режиме Testing, добавить рабочий Gmail в **Test users**.
3. В TeamBot открыть `/settings/connected-accounts/google-drive` и нажать **Connect**.
4. После согласия повторить Drive → Docs → Sheets smoke из
   [Google Docs editor runbook](runbooks/editor-google-docs.md).

До выполнения этих шагов код и production готовы, но живые пункты Google нельзя считать
подтверждёнными. OAuth client secret, ранее переданный через чат, следует ротировать и сохранить
только в production secret store.
