# Проверка стабильности ManacostTeam — 2 сентября 2026

Проверка выполнена на чистом worktree после changeset `d3202b5` (валидация транспортных ответов).
Проверки относятся к текущему web/API-коду и не являются подтверждением production deployment.

## Итог

| Проверка | Результат |
| --- | --- |
| lint | PASS — 750 файлов |
| typecheck | PASS — app, server, worker |
| полный тестовый прогон | PASS — 3248 pass, 23 skip, 0 fail; 3271 тест |
| production build | PASS — Vite, 8,9 с |
| runtime performance | PASS — 16 сценариев, 0 внешних запросов |
| secrets scan | PASS — утечек не найдено |
| dependency scan | baseline debt — 2 medium для `qs@6.15.3`, fixed `6.16.0` |

## Runtime performance

Измерение: Chromium 151, 30 измерений после 4 прогревов, production bundle и реальный DOM.

- Desktop: p95 30,2–69,6 мс во всех сценариях переключения, первой delta и истории до 10 000
  сообщений; пороги 100–700 мс.
- Mobile 390×844 при замедлении CPU 4×: p95 165,8–301,4 мс; пороги 400–2 800 мс.
- Windowing transcript ограничил одновременно смонтированные строки 42–60.

Это локальный render-gate: он не включает Telegram/Google auth, сеть, БД и задержку провайдера.
Production p50/p95 этих частей нужно смотреть в `/api/telemetry/workspace/summary`.

## Известный долг

`bun run format:check` всё ещё сообщает пять старых расхождений форматтера в `sign`, Telegram
plugin/health тестах и nginx тесте. Они были до текущего среза и намеренно не смешаны со
стабилизирующими изменениями; исправлять их следует отдельным mechanical-format commit.

Dependency scan обнаруживает `GHSA-4mjr-xmp4-gh2g` и `GHSA-x5fp-wj9c-mxmx` через транзитивный
`qs@6.15.3` в root `bun.lock`; upstream указывает `6.16.0`. Перед обновлением нужно проверить
совместимость Express/body-parser и зафиксировать override в манифесте, а не добавлять случайную
прямую зависимость только в lockfile.

## Воспроизведение

```sh
PATH=/home/debian/.bun/bin:$PATH bun run lint
PATH=/home/debian/.bun/bin:$PATH bun run typecheck
PATH=/home/debian/.bun/bin:$PATH bun test --path-ignore-patterns 'pdf-extractor/**' --path-ignore-patterns 'artifact-renderer/**'
PATH=/home/debian/.bun/bin:$PATH bun run build
PATH=/home/debian/.bun/bin:$PATH bun scripts/runtime-performance.ts
PATH=/home/debian/.bun/bin:$PATH /home/debian/server/tools/ai-quality/bin/ai-security-check quick
```
