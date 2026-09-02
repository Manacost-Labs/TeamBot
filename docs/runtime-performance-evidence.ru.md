# Runtime performance evidence

Дата прогона: 2 сентября 2026 года. Ревизия на момент прогона:
`4d71f7e705ad962a08dcc63ab8cb521decb2fa2b`, worktree чистый.

Статус: **PASS** — все browser performance gates уложились в заданный p95.

## Результаты

| Профиль | Сценарий | Выборка | p50 | p95 | p99 | Порог p95 | Результат |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Desktop | Тёплое переключение канала | 30 | 30.3 мс | 30.9 мс | 31.0 мс | <100 мс | PASS |
| Desktop | Холодный первый paint канала | 30 | 30.5 мс | 31.0 мс | 31.1 мс | <300 мс | PASS |
| Desktop | Принятая первая delta → видимый paint | 30 | 31.3 мс | 31.6 мс | 31.7 мс | <500 мс | PASS |
| Desktop | Богатая история, 50 сообщений | 30 | 31.2 мс | 31.6 мс | 31.7 мс | <300 мс | PASS |
| Desktop | Богатая история, 200 сообщений | 30 | 30.7 мс | 31.1 мс | 32.9 мс | <300 мс | PASS |
| Desktop | Богатая история, 500 сообщений | 30 | 30.6 мс | 31.1 мс | 31.3 мс | <300 мс | PASS |
| Desktop | Богатая история, 2 000 сообщений | 30 | 30.8 мс | 31.1 мс | 31.1 мс | <450 мс | PASS |
| Desktop | Богатая история, 10 000 сообщений | 30 | 30.8 мс | 31.2 мс | 32.2 мс | <700 мс | PASS |
| Mobile, 4× CPU | Тёплое переключение канала | 30 | 85.7 мс | 110.6 мс | 121.7 мс | <400 мс | PASS |
| Mobile, 4× CPU | Холодный первый paint канала | 30 | 79.9 мс | 100.0 мс | 105.0 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Принятая первая delta → видимый paint | 30 | 68.3 мс | 104.9 мс | 111.4 мс | <2 000 мс | PASS |
| Mobile, 4× CPU | Богатая история, 50 сообщений | 30 | 61.7 мс | 78.4 мс | 92.8 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Богатая история, 200 сообщений | 30 | 87.2 мс | 118.8 мс | 120.5 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Богатая история, 500 сообщений | 30 | 82.5 мс | 102.3 мс | 146.0 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Богатая история, 2 000 сообщений | 30 | 82.3 мс | 97.8 мс | 121.0 мс | <1 800 мс | PASS |
| Mobile, 4× CPU | Богатая история, 10 000 сообщений | 30 | 82.8 мс | 94.1 мс | 94.7 мс | <2 800 мс | PASS |

Истории содержат обычный текст, Markdown, таблицы, блоки кода, image attachments, tool calls,
artifact cards и Google Workspace cards. Windowing ограничил одновременно смонтированную историю:
42 строки для 50 сообщений и не более 60 строк для 200/500/2 000/10 000 сообщений.

## Методика

- Сборка: minified Vite production build отдельного fixture, импортирующего настоящий
  `ChatTranscript` и production CSS.
- Браузер: Chromium 151.0.7922.34, headless; desktop viewport 1440×900, mobile viewport 390×844,
  device scale 1.
- Профиль mobile дополнительно использует throttling CPU 4×; пороги в таблице уже учитывают это
  замедление.
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
