FROM oven/bun:1.3.14-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates git nodejs python3 ripgrep \
  && chmod u+s /usr/bin/bwrap \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/codex
RUN bun add @openai/codex@0.150.1 \
  && ln -s /opt/codex/node_modules/.bin/codex /usr/local/bin/codex

WORKDIR /app/agent-codex
COPY agent-codex/package.json agent-codex/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY agent-codex/src ./src
COPY agent-codex/src/research-source.mjs /usr/local/bin/research-source
COPY agent-codex/config.toml /home/bun/.codex/config.toml
COPY shared /app/shared

RUN mkdir -p /workspace /youtube-workspace /research-runs /home/bun/.codex \
  && chmod 0555 /usr/local/bin/research-source \
  && chown -R bun:bun /workspace /youtube-workspace /research-runs /home/bun/.codex /app

USER bun
ENV PORT=4202
EXPOSE 4202

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:4202/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
