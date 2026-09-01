# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# unzip is not in the Playwright image and bun's installer needs it.
ARG BUN_VERSION=1.3.14
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends unzip=6.0-28ubuntu4.1 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL -o /tmp/install-bun.sh https://bun.sh/install \
  && bash /tmp/install-bun.sh "bun-v${BUN_VERSION}" \
  && rm /tmp/install-bun.sh

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY --chown=1001:1001 agent-computer/package.json agent-computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=1001:1001 agent-computer/src ./src

# Durable working directory. Bot-produced files that must survive replacement live here.
RUN mkdir -p /workspace /profiles \
  && chown -R 1001:1001 /workspace /profiles
ENV WORKSPACE_DIR=/workspace
ENV PROFILES_DIR=/profiles

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD ["bun", "-e", "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"]

USER 1001:1001
CMD ["bun", "src/index.ts"]
