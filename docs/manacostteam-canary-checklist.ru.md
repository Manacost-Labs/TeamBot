# Canary ManacostTeam: пошаговый чек-лист

Этот документ описывает переход от текущего OpenBot runtime к ManacostTeam без одномоментного
переключения production-трафика. Каждый gate останавливается при первом несоответствии; следующий
gate нельзя считать пройденным по одному только `/health`.

## Границы и роли

- **Оператор** подготавливает изолированный listener/hostname, backup и immutable image IDs.
- **Владелец** проверяет свою Telegram-сессию, личные AI-подключения и доступ к своим данным.
- **Редактор** проверяет отдельную сессию, handoff и отсутствие доступа к owner-only данным.
- **Публичный origin** продолжает обслуживаться старой версией до завершения всех canary gates.

Ни один секрет, токен, полный Telegram ID, текст документа или содержимое production-канала не
записываются в этот файл, change ticket или timing-отчёт.

## Gate 0 — неизменяемая точка возврата

Перед любой работой с копией:

1. Зафиксировать commit SHA, image digest/ID, Compose project, hostname, ports и volume names.
2. Проверить чистое рабочее дерево и успешные format/typecheck/test/build/security gates.
3. Создать backup БД и отдельно согласованные snapshots attachment/workspace/browser volumes, если
   они участвуют в сценарии.
4. Восстановить backup в изолированную БД без production writer connection и проверить, что старый
   release читает восстановленную копию.
5. Подготовить rollback-комплект: старые server/agent/editor образы, proxy/DNS параметры,
   `OPENBOT_PUBLIC_URL`, auth mount и прежний edge-auth.

**Стоп:** backup не восстанавливается, counts различаются до rehearsal, либо rollback-комплект не
может быть запущен в изоляции.

## Gate 1 — owner binding на копии

1. Запустить owner-binding helper только в изолированном окружении и в dry-run проверить конфигурацию.
2. Выполнить idempotent binding к существующему внутреннему owner user ID.
3. Сравнить до/после только безопасные counts и разрешённые операционные IDs: users, channels,
   artifacts, attachments, routines, Google grants, AI connections и audit rows.
4. Проверить, что повторный binding не создаёт вторую account/session запись.
5. Проверить старым release чтение копии и откатить rehearsal-окружение после проверки.

**Стоп:** меняется внутренний owner ID, появляются новые записи вне ожидаемого binding, либо старый
release не читает копию.

## Gate 2 — isolated canary

Canary запускается на отдельном HTTPS hostname или loopback listener через SSH-туннель. Текущий
public origin и его edge-auth не изменяются.

### Обязательные smoke-сценарии

- Владелец входит через Telegram и видит свои каналы, историю, результаты и Google-подключение.
- Редактор входит отдельной сессией; его запросы и результаты принадлежат его actor ID.
- Владелец выполняет один короткий harmless run через ChatGPT/Codex и один через OpenRouter.
- Редактор выполняет разрешённый run и не может прочитать owner-only channel, artifact, grant или
  credential.
- Google Docs/Drive: чтение разрешённого документа и одна согласованная запись проходят через
  actor-owned grant; секреты отсутствуют в браузере, AG-UI и audit payload.
- Handoff между разрешёнными агентами создаёт ожидаемый logical run и не выдаёт чужой agent ID.
- Главный Аналитик и YouTube-аналитик завершаются только с валидным Markdown artifact; текстовый
  progress не меняет его на «Ответ готов».
- Logout, allowlist removal, connection disconnect и expired/revoked lease немедленно прекращают
  доступ без fallback на host Codex profile.

### Что записываем

Только pass/fail, timestamp, commit/image IDs, bounded error reason, run/thread/agent correlation
IDs и latency. Prompt, response, token, Telegram payload, OAuth code и содержимое файлов не
записываются.

**Стоп:** любой cross-user read, fallback на глобальный auth profile, secret match, ложное завершение
run, потерянный artifact, неправильный redirect или зависший worker.

## Gate 3 — решение о public cutover

Публичный переход требует отдельного письменного разрешения после Gate 2. В окне перехода:

1. Остановить новые routine-запуски и сделать финальный drain managed runs.
2. Переключить proxy/DNS на проверенный ManacostTeam release.
3. Удалить из live traffic `OPENBOT_SINGLE_USER`, Nginx `auth_request`, зависимость от edge-auth и
   глобальный `/home/debian/.codex/auth.json` mount.
4. Проверить точный Google OAuth redirect URI на новом origin.
5. Повторить owner/editor login, negative isolation, logout/revoke и один harmless run.
6. Наблюдать один обычный рабочий период; routine-worker возобновлять только после smoke.

**Немедленный rollback:** ошибка авторизации, истории, credentials, tool-governance, Google redirect,
artifact contract или cross-user isolation. Возвращается согласованный server + agent + editor +
proxy/DNS комплект; новые additive rows не удаляются.

## Критерий готовности

Canary считается успешным только если Gates 0–2 имеют evidence без секретов, оба пользователя прошли
положительные и отрицательные сценарии, а rollback проверен на копии. До этого публичный
`work.kolodahearthstone.com` остаётся на текущем совместимом пути.
