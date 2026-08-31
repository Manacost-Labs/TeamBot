# Runtime performance evidence

Дата прогона: 31 августа 2026 года. Ревизия на момент прогона:
`c8e0c8426b1fb5d48d986f26cdc7184c3b695d3a`, worktree содержал незакоммиченные изменения.

Статус: **PASS** — все browser performance gates уложились в заданный p95.

## Результаты

| Сценарий | Выборка | p50 | p95 | p99 | Порог p95 | Результат |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Тёплое переключение канала | 30 | 30.0 мс | 33.9 мс | 36.3 мс | <100 мс | PASS |
| Холодный первый paint канала | 30 | 30.1 мс | 35.7 мс | 36.3 мс | <300 мс | PASS |
| Принятая первая delta → видимый paint | 30 | 30.2 мс | 30.6 мс | 33.1 мс | <500 мс | PASS |
| Богатая история, 50 сообщений | 30 | 30.0 мс | 30.6 мс | 34.6 мс | <300 мс | PASS |
| Богатая история, 200 сообщений | 30 | 29.9 мс | 31.5 мс | 32.0 мс | <300 мс | PASS |
| Богатая история, 500 сообщений | 30 | 30.0 мс | 33.6 мс | 47.0 мс | <300 мс | PASS |

Истории содержат обычный текст, Markdown, таблицы, блоки кода, image attachments, tool calls,
artifact cards и Google Workspace cards. Windowing ограничил одновременно смонтированную историю:
42 строки для 50 сообщений и не более 60 строк для 200/500 сообщений.

## Методика

- Сборка: minified Vite production build отдельного fixture, импортирующего настоящий
  `ChatTranscript` и production CSS.
- Браузер: Chromium 151.0.7922.173, headless, viewport 1440×900, device scale 1.
- Каждый переход запускается настоящим DOM `click` handler. Результат принимается только после
  React commit и двух последовательных `requestAnimationFrame`; в этот момент проверяются видимость
  marker и число DOM-строк.
- Для каждого сценария: четыре warm-up и 30 фиксированных измерений; p50/p95/p99 рассчитаны тем же
  nearest-rank алгоритмом, что и workspace telemetry.
- Профиль машины: AMD Ryzen 7 9700X, 16 logical CPU, 67 GB RAM.
- Внешние запросы блокируются; за весь прогон выполнено 0 внешних запросов.

Это воспроизводимый UI/render release gate. Он намеренно исключает авторизацию, сеть, backend и
provider latency. Поэтому холодный сценарий означает первый mount ранее не открытого transcript,
а first delta — путь от уже принятой browser state delta до paint. Реальные production p50/p95 по
сети и модели по-прежнему нужно читать из `/api/telemetry/workspace/summary`.

Content-free JSON с revision, machine profile, методикой, p50/p95/p99 и результатами thresholds:
[`runtime-performance-evidence.json`](runtime-performance-evidence.json).

## Воспроизведение

```sh
bun scripts/runtime-performance.ts
```

Скрипт сам собирает временный production bundle, запускает локальный сервер и Chromium, печатает
машиночитаемый JSON и возвращает ненулевой код при превышении хотя бы одного p95. Временная сборка
удаляется после прогона. При необходимости сохранить JSON:

```sh
bun scripts/runtime-performance.ts --json docs/runtime-performance-evidence.json
```

Отдельный обязательный streaming gate с управляемыми паузами между тремя delta:

```sh
bun test app/tests/progressive-streaming.test.tsx
```

Он проверяет последовательность `delta 1 → wait → delta 2 → wait → delta 3` и подтверждает, что
DOM показывает каждое промежуточное состояние до разрешения следующей delta.
