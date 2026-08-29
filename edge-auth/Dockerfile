FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY edge-auth/package.json edge-auth/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY edge-auth/src ./src
RUN chown -R bun:bun /app
USER bun
ENV PORT=3030
EXPOSE 3030
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3030/health'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "src/index.ts"]
