# Runtime performance evidence

Дата прогона: 2 сентября 2026 года. Ревизия на момент прогона:
`93cc34b4b667d0f3ab93e70aeb9082f9b260cd9f`, worktree чистый.

Статус: **PASS** — все browser performance gates уложились в заданный p95.

## Результаты

| Профиль | Сценарий | Выборка | p50 | p95 | p99 | Порог p95 | Результат |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Desktop | Тёплое переключение канала | 30 | 29.6 мс | 33.6 мс | 34.3 мс | <100 мс | PASS |
| Desktop | Холодный первый paint канала | 30 | 29.0 мс | 33.9 мс | 45.3 мс | <300 мс | PASS |
| Desktop | Принятая первая delta → видимый paint | 30 | 29.9 мс | 30.5 мс | 31.9 мс | <500 мс | PASS |
| Desktop | Богатая история, 50 сообщений | 30 | 30.1 мс | 30.6 мс | 31.7 мс | <300 мс | PASS |
| Desktop | Богатая история, 200 сообщений | 30 | 29.4 мс | 32.3 мс | 34.5 мс | <300 мс | PASS |
| Desktop | Богатая история, 500 сообщений | 30 | 29.9 мс | 31.1 мс | 47.0 мс | <300 мс | PASS |
| Desktop | Богатая история, 2 000 сообщений | 30 | 29.6 мс | 35.0 мс | 45.3 мс | <450 мс | PASS |
| Desktop | Богатая история, 10 000 сообщений | 30 | 30.0 мс | 45.0 мс | 45.2 мс | <700 мс | PASS |
| Mobile, 4× CPU | Тёплое переключение канала | 30 | 124.8 мс | 151.1 мс | 157.5 мс | <400 мс | PASS |
| Mobile, 4× CPU | Холодный первый paint канала | 30 | 121.3 мс | 152.3 мс | 156.5 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Принятая первая delta → видимый paint | 30 | 96.0 мс | 132.5 мс | 133.7 мс | <2 000 мс | PASS |
| Mobile, 4× CPU | Богатая история, 50 сообщений | 30 | 83.6 мс | 95.2 мс | 133.1 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Богатая история, 200 сообщений | 30 | 122.0 мс | 149.3 мс | 162.4 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Богатая история, 500 сообщений | 30 | 113.6 мс | 147.6 мс | 164.0 мс | <1 200 мс | PASS |
| Mobile, 4× CPU | Богатая история, 2 000 сообщений | 30 | 117.6 мс | 137.4 мс | 140.4 мс | <1 800 мс | PASS |
| Mobile, 4× CPU | Богатая история, 10 000 сообщений | 30 | 116.6 мс | 134.9 мс | 146.9 мс | <2 800 мс | PASS |

Истории содержат обычный текст, Markdown, таблицы, блоки кода, image attachments, tool calls,
artifact cards и Google Workspace cards. Windowing ограничил одновременно смонтированную историю:
42 строки для 50 сообщений и не более 60 строк для 200/500/2 000/10 000 сообщений.

## Методика

- Сборка: minified Vite production build отдельного fixture, импортирующего настоящий
  `ChatTranscript` и production CSS.
- Браузер: Chromium 151.0.7922.173, headless; desktop viewport 1440×900, mobile viewport 390×844,
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
- Маршрут `/results` остаётся ленивым: production chunk страницы — 4 689 байт до gzip; тяжёлый
  чат не входит в её initial chunk.

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
