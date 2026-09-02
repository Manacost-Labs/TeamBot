# Quality baseline — 2026-09-02

Этот короткий отчёт фиксирует состояние проверок после изолированной репетиции Task 32. Он не
изменяет production и не заменяет отдельную проверку перед canary/cutover.

## Пройдено

- `bun run lint` — успешно, Biome проверил 742 файла.
- `bun run typecheck` — успешно во всех workspace.
- `bun run build` — успешно; остались только предупреждения Vite о тестовых route-файлах и крупных
  чанках.
- `/home/debian/server/tools/ai-quality/bin/ai-security-check` — успешно: утечек секретов и новых
  проблем dependency scan не найдено.
- Целевые повторы трёх таймаутов полного запуска прошли отдельно: лимит активных расписаний,
  истечение lease загрузки и выход из ChatGPT-входа.

## Текущий baseline, который не исправлялся в Task 32

Полный `bun test` внутри `ai-check` завершился с `3232 pass`, `23 skip`, `4 fail` и `1 error`.
Три именованных таймаута из этого запуска проходят изолированно (см. выше); четвёртый случай —
безымянный timeout `beforeEach/afterEach` при параллельном запуске и отдельно не воспроизведён.

`bun run format:check` нашёл пять файлов, которым Biome предлагает форматирование:

- `app/src/routes/sign.test.tsx`
- `app/src/routes/sign.tsx`
- `server/tests/health.test.ts`
- `server/tests/telegram-plugin.test.ts`
- `tests/nginx-telegram-oidc.test.ts`

Автоматическое форматирование этих несвязанных файлов не выполнялось, чтобы не смешивать baseline
с доказательствами Task 32. Перед Task 33 следует либо оформить отдельный небольшой cleanup, либо
повторить gate после согласованного исправления; failing-check нельзя отключать.

