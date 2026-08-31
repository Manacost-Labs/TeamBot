# Главный редактор: подтверждаемая запись в Google Docs

## Пользовательский сценарий

1. Пользователь подключает Google в `/settings/connected-accounts/google-drive`.
2. Администратор выдаёт Главному редактору `read_google_document` и `replace_google_doc_range`.
3. Пользователь отправляет каноническую ссылку `https://docs.google.com/document/d/<id>/edit`.
4. Редактор читает документ, правит текст и прогоняет результат через analyzer.
5. Если правка принята и её можно точно сопоставить с Google Docs, ответ содержит ссылку «Проверить и сохранить в Google Docs».
6. Пользователь открывает diff и нажимает «Сохранить в Google Docs».

До шага 6 документ не меняется. Write grant нужен серверному контуру подтверждения, но write-tool не попадает в список инструментов модели.

## Production-конфигурация

`editor-gateway` должен получить:

```text
EDITOR_OPENBOT_URL=http://openbot:3001
EDITOR_OPENBOT_TOKEN=<тот же AGENT_TOOL_TOKEN, который настроен у TeamBot>
```

Токен хранится только в окружении gateway. Он не включается в AG-UI `forwardedProps`, prompt, transcript или ответ пользователю. TeamBot проверяет его вместе с подписанным `openbotRun`, поэтому actor, Bot, run и thread нельзя подменить телом запроса.

Нужна миграция `0030_confirmed_google_document_edits`. Таблица хранит actor/Bot/thread, безопасные счётчики, digest, состояние и единственный content-bearing ciphertext. После `succeeded`, `not_applied`, `ambiguous`, `expired`, `declined` или `superseded` ciphertext очищается.

## Границы безопасности

- только один tab;
- не более 30 изменённых абзацев;
- один изменённый plain-text run на абзац;
- до 2000 UTF-16 единиц исходного диапазона;
- до 10 000 символов всего нового текста;
- без таблиц, оглавлений, структурных переносов и удаления абзацев;
- точное совпадение полного bounded-rendering с прочитанным редактором источником;
- одна Google `batchUpdate`, диапазоны по убыванию индексов;
- `writeControl.requiredRevisionId` берётся из подготовленного preview, а не перечитывается после подтверждения;
- owner-only API и same-origin JSON POST для решения;
- grant, policy, OAuth и scope проверяются снова непосредственно перед записью.

## Состояния

```text
pending → dispatching → succeeded | not_applied | ambiguous
pending → declined | expired | superseded
```

`dispatching` не переиспользуется. Если процесс потерял ответ после возможной отправки, операция становится `ambiguous`, а интерфейс просит проверить документ вручную.

## Диагностика

- Нет ссылки сохранения: проверьте личное Google connection, оба grants, single-tab/structure ограничения и полноту чтения.
- `not_applied`: документ изменился после preview, отозван grant/OAuth или policy запретила write. Попросите редактора прочитать свежую версию.
- `ambiguous`: откройте Google Doc и проверьте результат; не создавайте автоматический retry.
- 401 внутреннего prepare: `EDITOR_OPENBOT_TOKEN` не совпадает с `AGENT_TOOL_TOKEN` либо подписанный run истёк.
- 403 Google: Docs API выключен, аккаунт не имеет доступа к документу или scope `documents` не выдан; переподключите Google после изменения scopes.

В audit ищите `google_doc_edit.*` и связанный `mcp.call_*`. Открытый текст документа, OAuth token и captured revision там отсутствуют.

## Smoke после выпуска

1. Открыть маленький single-tab Google Doc без таблиц.
2. Отправить ссылку Главному редактору и дождаться принятой правки.
3. Открыть review и сверить «Было/Стало».
4. Нажать сохранение дважды или параллельно в двух вкладках.
5. Убедиться, что Google получил каждую замену ровно один раз.
6. Создать новое предложение, изменить документ вручную до подтверждения и убедиться в `not_applied` без частичной записи.
7. Проверить, что terminal row имеет `encrypted_payload = NULL`, а audit не содержит изменённую фразу.
