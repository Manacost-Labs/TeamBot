# The framework Bot. Same shape as agent-bot and the same absence of a browser: this process speaks
# AG-UI and talks to a model, and the computer it drives is a separate container with its own
# lifecycle. Two Bots in the box rather than one, so "any AG-UI agent is a Bot" is demonstrated by
# two implementations that share nothing but the protocol.
FROM oven/bun:1.3-alpine

WORKDIR /app
RUN chown bun:bun /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY --chown=1000:1000 agent-langgraph/package.json agent-langgraph/bun.lock ./agent-langgraph/
WORKDIR /app/agent-langgraph
RUN bun install --frozen-lockfile
WORKDIR /app

# The repo's own layout, kept exactly, so `../../shared/bot-prompt` resolves the same here as it
# does on a laptop. Flattening src to /app/src would change the depth and break only on deploy.
COPY --chown=1000:1000 shared ./shared
COPY --chown=1000:1000 agent-langgraph/src ./agent-langgraph/src

ENV PORT=4201
EXPOSE 4201
USER 1000:1000
CMD ["bun", "agent-langgraph/src/index.ts"]
