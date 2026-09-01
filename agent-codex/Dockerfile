FROM oven/bun:1.3.14-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates=20250419 \
    git=1:2.47.3-0+deb13u1 \
    nodejs=20.19.2+dfsg-1+deb13u2 \
    python3=3.13.5-1 \
    ripgrep=14.1.1-1+b4 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/codex
RUN bun add @openai/codex@0.150.1 \
  && ln -s /opt/codex/node_modules/.bin/codex /usr/local/bin/codex

WORKDIR /app/agent-codex
COPY agent-codex/package.json agent-codex/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY agent-codex/src ./src
COPY agent-codex/config.toml ./config.toml
COPY agent-codex/src/research-source.mjs /usr/local/bin/research-source
COPY shared /app/shared

RUN mkdir -p /workspace /youtube-workspace /research-runs /run/openbot-codex \
  && chmod 0555 /usr/local/bin/research-source \
  && chmod 0700 /run/openbot-codex \
  && chown -R bun:bun /workspace /youtube-workspace /research-runs /run/openbot-codex /app

USER 1000:1000
ENV PORT=4202
ENV CODEX_PROFILE_ROOT=/run/openbot-codex
EXPOSE 4202

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:4202/health'); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "src/index.ts"]
