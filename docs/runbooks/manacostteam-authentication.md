# ManacostTeam: Telegram-вход и личные AI-подключения

Этот runbook описывает подготовленный в репозитории ManacostTeam runtime. Он не разрешает работу с
production-данными, canary deployment или переключение публичного трафика: для Tasks 32–34 нужно
отдельное одобрение владельца. Общая процедура deployment и backup находится в
[Production operations](../production-operations.ru.md), а фактические границы контейнеров — в
[Production runtime](../production-runtime.ru.md).

Ниже нет значений секретов. Не передавайте в чат, аргументы команд, тикет или журнал Telegram bot
token, `BETTER_AUTH_SECRET`, OpenRouter key, ChatGPT/Codex auth document, Google client secret,
cookies или содержимое `.env*`.

## Две разные авторизации

| Что подтверждает          | Где выполняется                                                      | Что не даёт                                                         |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Вход через Telegram**   | Страница входа ManacostTeam и server-side проверка Telegram callback | Не даёт доступ к модели и не использует ChatGPT/OpenRouter как роль |
| **Личное AI-подключение** | `/settings`, отдельно для каждого вошедшего пользователя             | Не создаёт сессию ManacostTeam и не меняет роль пользователя        |

Telegram определяет внутреннего пользователя и роль: ID из `TELEGRAM_OWNER_USER_IDS` становится
администратором, остальные ID из allowlist — редакторами. Авторизация опирается только на неизменный
числовой Telegram ID, а не на `@username`, имя или фотографию.

После входа каждый пользователь подключает ровно один личный provider: **ChatGPT / Codex** или
**OpenRouter**. Отсутствие подключения означает отказ запуска с предложением открыть настройки;
fallback на аккаунт владельца, host `auth.json` или общий model key отсутствует.

## Текущее состояние source release

`docker-compose.production.yml` уже описывает Telegram-сессии и personal-provider runtime:

- `OPENBOT_SINGLE_USER` по умолчанию выключен, а Telegram mode отказывается стартовать, если он
  равен `true`;
- server получает Telegram token и ID sets, но `agent-codex` их не получает;
- из `.env.manacostteam-auth` в `agent-codex` попадает только имя server-selected OpenRouter model;
  отдельные research-provider credentials и внутренние service credentials остаются существующими
  runtime inputs с tool/model redaction boundary;
- host `auth.json`, общий ChatGPT profile и глобальный OpenRouter key не монтируются;
- каждый Codex child получает временный `CODEX_HOME` под memory-backed `/run/openbot-codex`;
- `edge-auth` пока сохранён как часть старого public gateway и полного rollback-набора.

Tasks 1–31 меняют только source release. Пока не выполнены отдельно одобренные Tasks 32–34,
публичный `work.kolodahearthstone.com` и действующий edge gateway не переключаются.

## 1. Подготовка Telegram bot и базовой конфигурации

### BotFather Web Login Allowed URLs

В официальном `@BotFather` откройте существующий bot → **Bot Settings** → **Web Login** и добавьте
оба точных значения для каждого canary/public target:

- HTTPS origin без завершающего `/`, например `https://work.kolodahearthstone.com`;
- callback `https://work.kolodahearthstone.com/api/auth/telegram/callback`.

Allowed URLs поддерживает несколько адресов, поэтому URL HearthPulse не заменяйте: добавляйте
ManacostTeam рядом с ним. В `.env` задайте тот же `OPENBOT_PUBLIC_URL`, а OIDC client ID/secret
возьмите из настроек этого bot. Проверка считается успешной только когда `/telegram/start`
перенаправляет на `https://oauth.telegram.org/auth` без ошибки domain/redirect URI.

### Какие значения где хранятся

В защищённом `.env` остаются deployment-wide настройки, в том числе:

- `OPENBOT_PUBLIC_URL`;
- `OPENBOT_SINGLE_USER=false` (либо старое значение удалено, чтобы Compose применил `false`);
- `BETTER_AUTH_SECRET` длиной не менее 32 символов;
- `TELEGRAM_LOGIN_BOT_USERNAME`;
- `KEY_ENCRYPTION_KEY` для credential vault;
- внутренние `MANAGED_AGENT_TOKEN` и `AGENT_TOOL_TOKEN`.

Игнорируемый Git файл `.env.manacostteam-auth` с режимом `0600` содержит только:

- `TELEGRAM_LOGIN_BOT_TOKEN`;
- `TELEGRAM_OIDC_CLIENT_ID`;
- `TELEGRAM_OIDC_CLIENT_SECRET`;
- полный `TELEGRAM_ALLOWED_USER_IDS`;
- непустое подмножество `TELEGRAM_OWNER_USER_IDS`;
- server-selected `OPENROUTER_MODEL`.

Не создавайте этот файл вручную через command-line assignment. Из корня source repository запустите
helper и вводите значения только в его скрытые prompts:

```sh
./scripts/configure-manacostteam-auth.sh
./scripts/configure-manacostteam-auth.sh --dry-run
```

Пустой ответ сохраняет текущее значение. Helper атомарно пишет mode-`0600` файл, запрещает пустой
owner set и выводит только имена отсутствующих/невалидных полей и результат отношений между ID sets.
Он никогда не показывает значения. `--dry-run` ничего не изменяет.

- **Preflight:** перед перезаписью сохраните прежний файл в approved private backup и проверьте, что
  target — обычный mode-`0600` файл этого source repository, не symlink/hardlink.
- **Exact target:** только `.env.manacostteam-auth`; helper не изменяет `.env`, Compose или runtime.
- **Проверка:** `./scripts/configure-manacostteam-auth.sh --dry-run` завершается успешно, а
  `git status --short -- .env.manacostteam-auth` ничего не показывает, потому что файл ignored.
- **Rollback:** восстановите прежний private backup тем же защищённым operator workflow и повторите
  dry-run. Не печатайте и не сравнивайте содержимое в terminal output.

Проверяйте Compose без печати развёрнутого YAML:

```sh
docker compose \
  --env-file .env \
  --env-file .env.manacostteam-auth \
  -f docker-compose.production.yml \
  config --quiet
```

Не заменяйте эту команду на `docker compose config` без второго env-file: protected values участвуют
в Compose interpolation, но не передаются всем контейнерам как общий `env_file`.

## 2. Одноразовая привязка владельца

Привязка соединяет выбранный Telegram subject с существующим внутренним пользователем
`dev-local-user`. Так сохраняются его каналы, файлы, grants, Google connections и история. Команда
идемпотентна, dry-run по умолчанию и не принимает ID аргументом.

Это изменение production-данных относится к Task 32 и до отдельного одобрения выполняется только на
проверенной изолированной копии базы.

- **Preflight:** проверьте backup/restore, подключение именно к изолированной БД, наличие ID в обоих
  protected sets и отсутствие других Telegram bindings у retained owner. Зафиксируйте counts
  принадлежащих owner ресурсов без их содержимого.
- **Exact target:** ровно строка `dev-local-user` в выбранной изолированной БД и один ID, введённый в
  prompt. `DATABASE_URL` и protected owner set загружаются штатным package command.
- **Dry-run:** выполните команду и введите ID только после prompt:

  ```sh
  bun run bind:telegram-owner
  ```

- **Apply:** после успешного dry-run повторите с явным флагом и снова введите ID через prompt:

  ```sh
  bun run bind:telegram-owner -- --apply
  ```

- **Проверка:** команда сообщает о созданной/уже корректной binding без вывода ID; после canary
  owner входит через Telegram как администратор и видит прежние resource counts под тем же internal
  actor ID.
- **Rollback:** не удаляйте account row и не исправляйте роль SQL-командой. При ошибочной привязке
  остановите writers и восстановите проверенный snapshot в изолированной БД. Старый совместимый
  release игнорирует additive Telegram rows, поэтому обычный image rollback их не удаляет.

## 3. Добавление редактора в allowlist

Helper всегда принимает **полные** списки, а не один добавляемый ID. Пользователь из allowlist, но не
из owner set получает роль `user`, отображаемую как редактор.

1. Запустите `./scripts/configure-manacostteam-auth.sh` и в скрытом prompt
   `TELEGRAM_ALLOWED_USER_IDS` введите полный новый список. Пустыми ответами сохраните неизменяемые
   поля. Не добавляйте редактора в `TELEGRAM_OWNER_USER_IDS`.
2. Выполните `./scripts/configure-manacostteam-auth.sh --dry-run`.
3. До deployment убедитесь, что хотя бы один уже привязанный owner остаётся в обоих списках.

Применение allowlist к работающему server меняет доступ:

- **Preflight:** запишите предыдущие protected config file backup/metadata без вывода содержимого;
  подтвердите health, active owner login и завершение managed runs.
- **Exact target:** `openbot` и `routine-worker` из `docker-compose.production.yml`; helper добавляет
  `routine-worker` автоматически при targeted replacement `openbot`.
- **Изменение:** после отдельного deployment approval выполните
  `./scripts/deploy-production.sh openbot`.
- **Проверка:** существующий owner продолжает входить; новый редактор входит через Telegram и не
  видит `/admin`; неизвестный ID получает общий отказ без metadata приложения.
- **Rollback:** восстановите прежний protected config штатным secret workflow, подтвердите
  `--dry-run`, затем тем же drain-aware helper замените `openbot`. Не используйте
  `docker compose down -v`.

## 4. Завершение доступа и сессий

Есть два разных механизма.

### Явный revoke уже вошедшего пользователя

Владелец открывает `/admin/people`, выбирает точную строку человека и нажимает **Remove**. Server
создаёт sticky database deny, удаляет активные сессии и отзывает принадлежащие пользователю
credentials. Self-revoke и revoke администратора из `INITIAL_ADMIN_EMAILS` server отклоняет.
Telegram owner не получает эту защиту только из-за membership в owner set: другой администратор
технически может отозвать его доступ, а отзыв последнего live Telegram owner остановит следующий
startup reconciliation. Поэтому такой owner должен считаться защищённой операционной целью.

- **Preflight:** сверяйте внутреннюю строку пользователя и Telegram provider, а не похожее имя;
  убедитесь, что это не текущий actor, не единственный live Telegram owner и после действия остаётся
  рабочий owner из configured owner set.
- **Exact target:** одна строка на `/admin/people`; не массовый список и не весь allowlist.
- **Проверка:** отдельная уже открытая сессия этого пользователя перестаёт проходить API, новый
  Telegram login отклоняется, в audit есть `person.access_revoked` без credential/prompt content.
- **Rollback:** нажмите **Restore** для той же строки. Это снимает sticky deny, но не возвращает
  отозванное личное AI-подключение: пользователь подключает provider заново.

### Удаление ID из configuration allowlist

Для пользователя, который ещё не появился в People, либо для configuration-level removal измените
полный список скрытым helper и примените только `openbot` drain-aware deployment как в разделе 3.
Boot reconciliation удаляет активные сессии bound пользователя. Возврат ID в allowlist снова
разрешает вход, если отдельно не установлен sticky revoke; в последнем случае требуется и
**Restore** на People.

Никогда не удаляйте последний owner. Helper откажется записать пустой owner set, а server откажется
стартовать без live owner binding.

## 5. Личное подключение ChatGPT / Codex

Эту процедуру выполняет сам вошедший пользователь в `/settings`:

1. В секции **ChatGPT / Codex** нажать **Подключить ChatGPT**.
2. Открыть показанную официальную страницу OpenAI в отдельной вкладке.
3. Ввести показанный одноразовый code на странице OpenAI. Пароль, token или `auth.json` в
   ManacostTeam не вводятся.
4. Дождаться статуса **ChatGPT / Codex подключён**; polling завершится автоматически.

Код ограничен по времени и виден только пользователю, начавшему flow. При отмене, timeout, смене
пользователя или restart незавершённый flow не становится подключением.

Повторное подключение или переход с OpenRouter заменяет credential только после успешного нового
входа. **Отключить ChatGPT** немедленно запрещает новые/queued runs, но не удаляет transcript.

- **Preflight для replace/disconnect:** убедитесь, какой provider показан активным и что нет нужного
  незавершённого run.
- **Exact target:** personal AI connection текущего authenticated actor, без user ID в URL/body.
- **Проверка:** Settings показывает ожидаемый safe status; harmless run выполняется под тем же actor
  и provider; browser/tool/log scan не содержит code после завершения или auth document.
- **Rollback:** старый credential не восстанавливается. Пройдите новый device login; не монтируйте
  host profile и не копируйте `auth.json`.

## 6. Личное подключение OpenRouter

Пользователь получает собственный key у OpenRouter и вводит его в password field **Ключ
OpenRouter** на `/settings`. Поле очищается сразу; сохранённый key никогда не возвращается в
browser. Server сначала проверяет key на фиксированном OpenRouter endpoint и только затем
зашифровывает и активирует его. Model выбирает оператор через `OPENROUTER_MODEL`; пользователь не
может передать model или base URL.

Если уже активен ChatGPT, UI отдельно просит подтвердить замену. **Заменить ключ** и **Отключить**
затрагивают только connection текущего actor.

- **Preflight для replace/disconnect:** проверьте активный provider и сохраните новый key в личном
  approved secret manager, не в clipboard history/chat.
- **Exact target:** personal AI connection текущего authenticated actor.
- **Проверка:** Settings показывает **OpenRouter подключён**, harmless run проходит, а key
  отсутствует в browser response, shell/tool environment, audit и logs.
- **Rollback:** прежний key/ChatGPT credential не возвращается автоматически. Введите новый
  OpenRouter key или заново пройдите ChatGPT device flow.

## 7. Canary — только после отдельного одобрения

Task 33 использует отдельный HTTPS hostname либо loopback-only deployment через SSH tunnel. Текущий
`deploy-production.sh` обслуживает один Compose target из корня repository и не создаёт изолированный
canary сам. Нельзя запускать его второй раз на live host с теми же ports/volumes/project name.

- **Preflight:** Task 32 завершён на восстановленной копии; в change ticket названы точные canary
  host/listener, Compose project, database copy, volumes, commit/image IDs, HTTPS hostname,
  BotFather Allowed URLs и полный предыдущий rollback set. Canary не имеет production writer connection.
- **Exact target:** только перечисленный canary project/host и copied database. Public
  `work.kolodahearthstone.com`, live proxy, live volumes и live database исключены.
- **Deployment:** используйте одобренную для этого конкретного target команду. Если target не
  поддерживает существующий drain-aware helper без смены live ports/volumes, Task 33 заблокирован до
  появления отдельного Compose/host procedure — не импровизируйте на production.
- **Проверка:** owner/editor Telegram sessions различны; оба выполняют harmless personal-provider
  run; editor не читает owner channels/artifacts/attachments/Google connection; Google Docs через
  уже подключённый owner grant, handoff, research и YouTube artifact проходят; logout, revoke,
  provider disconnect и restart не оставляют ложный status или plaintext credential.
- **Rollback:** остановите только canary writers, верните записанный полный совместимый
  server+agent+editor image/config set и прежний canary proxy target, затем повторите canary health и
  negative isolation checks. Live public route при этом не меняется.

Source build/deploy и canary не являются поводом менять Google OAuth JavaScript origin или callback.
До public cutover используется текущая регистрация, а canary проверяет уже существующий personal
Google grant. Если canary требует новый Google consent, это отдельное изменение scope и approval, а
не скрытая часть deployment.

## 8. Public cutover (Task 34)

Переключение `work.kolodahearthstone.com` не входит в Tasks 1–31. Его можно начать только после
пройденного canary и отдельного явного approval.

- **Preflight:** проверены backup/restore, immutable previous images, owner binding, owner/editor
  canary, logout/revoke, оба personal providers и полный rollback set; TTL/proxy control, точный
  внешний public gateway target и текущие BotFather Allowed URLs записаны. Подтвердите доступ
  к официальному `@BotFather` и точный существующий bot по username, не по display name. В
  репозитории есть rollback-конфигурация
  `ops/nginx/work-origin.kolodahearthstone.com.conf`; конфигурация внешнего public gateway здесь не
  хранится, поэтому его точный control plane должен быть назван в change ticket.
- **Exact target:** public host `work.kolodahearthstone.com`, его proxy/DNS route, согласованный live
  server+agent+editor release и заранее добавленные origin/callback в Web Login Allowed URLs
  выбранного Telegram bot.
  `work-origin.kolodahearthstone.com` и `edge-auth` остаются rollback targets до конца observation
  window.
- **Google OAuth на этой границе:** только теперь добавьте в Google Cloud Web client точные значения
  `https://work.kolodahearthstone.com` и
  `https://work.kolodahearthstone.com/api/plugins/oauth/callback`. Сверьте callback, показанный на
  `/admin/plugins/google-drive`. Старый origin/redirect пока не удаляйте.
- **Переключение:** установите live `OPENBOT_PUBLIC_URL` в public HTTPS origin, примените полный
  согласованный release через drain-aware procedure. Затем уберите public `auth_request`/ChatGPT
  gateway dependency и направьте public proxy/DNS на проверенный ManacostTeam origin. Не возвращайте
  global `auth.json` mount рядом с новым multi-user server.
- **Проверка:** BotFather содержит точные public origin/callback, OIDC redirect открывается,
  owner входит до и после switch, editor — после; cookie имеет `HttpOnly`, `Secure` и `SameSite=Lax`
  или строже; callback не содержит открытого redirect; каждый пользователь видит только свои
  данные/provider/Google grant; repeat smoke охватывает Docs, handoff, research, YouTube,
  logout/revoke и audit attribution без prompt/secret content.
- **Rollback:** одним change верните прежний public proxy/DNS route, старый полный
  server+agent+edge-auth set, его прежний origin configuration и записанный pre-cutover BotFather
  Allowed URLs. Повторите old edge login, history, AG-UI и Google callback checks; если canary остаётся
  доступен, повторите его Telegram OIDC check. Additive rows и ciphertext не удаляйте; не
  смешивайте старый global profile с новым server. Оба Google redirect URI держите
  зарегистрированными до успешного rollback/observation завершения.

## 9. Быстрая диагностика

| Симптом                                      | Проверить                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Telegram-кнопка не появляется                | Telegram mode и `/api/capabilities`; внешний widget/script больше не используется                     |
| Telegram login возвращает общий отказ        | Allowed URLs, OIDC client, ID в allowlist, owner binding, access not revoked                           |
| После удаления ID старая вкладка ещё открыта | Любой защищённый API должен уже отказать; статичный экран не доказывает живую сессию                  |
| `AI недоступен`                              | У текущего пользователя нет active personal provider; подключить его в `/settings`                    |
| ChatGPT code истёк                           | Запустить новый flow; старый code/profile не восстанавливать                                          |
| OpenRouter key отклонён                      | Проверить key/limit у OpenRouter; key не логировать и не переносить в deployment env                  |
| Google `redirect_uri_mismatch`               | Не менять Cloud client во время build/deploy; на public cutover сравнить URI из plugin UI посимвольно |

## Связанные документы

- [Approved specification](../manacostteam-telegram-auth-spec.md)
- [Implementation plan](../manacostteam-telegram-auth-plan.md)
- [Production operations](../production-operations.ru.md)
- [Google Workspace connector](../plugins/google-drive.md)
