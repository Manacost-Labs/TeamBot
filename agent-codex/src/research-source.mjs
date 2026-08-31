#!/usr/bin/env node

const baseUrl = (
  process.env.RESEARCH_SOURCES_URL || "http://research-sources:8777"
).replace(/\/$/, "");
const token = process.env.RESEARCH_SOURCE_GATEWAY_TOKEN || "";
const args = process.argv.slice(2);
const command = args.shift() || "";

function option(name, required = false) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) {
    if (required) throw new Error(`missing --${name}`);
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}`) {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`missing --${name}`);
      values.push(value);
    }
  }
  return values;
}

function integer(name, fallback) {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`invalid --${name}`);
  return parsed;
}

function requestBody() {
  if (command === "doctor") return { command };
  if (command === "reddit-posts") {
    return {
      command,
      options: {
        subreddit: option("subreddit", true),
        sort: option("sort"),
        timeframe: option("timeframe"),
        limit: integer("limit", 25),
        after: option("after"),
      },
    };
  }
  if (command === "reddit-search") {
    return {
      command,
      options: {
        query: option("query", true),
        subreddit: option("subreddit"),
        sort: option("sort"),
        timeframe: option("timeframe"),
        limit: integer("limit", 25),
        after: option("after"),
      },
    };
  }
  if (command === "reddit-comments") {
    return { command, options: { post_id: option("post-id", true) } };
  }
  if (command === "x-search") {
    return {
      command,
      options: {
        query: option("query", true),
        product: option("product"),
        cursor: option("cursor"),
      },
    };
  }
  if (command === "youtube-search") {
    return {
      command,
      options: {
        query: option("query", true),
        limit: integer("limit", 20),
      },
    };
  }
  if (command === "youtube-transcript") {
    return {
      command,
      options: {
        video: option("video", true),
        language: option("language"),
      },
    };
  }
  if (command === "tinyfish-search") {
    return {
      command,
      options: {
        query: option("query", true),
        location: option("location"),
        language: option("language"),
        include_domains: option("include-domains"),
        exclude_domains: option("exclude-domains"),
        page: integer("page", 0),
      },
    };
  }
  if (command === "tinyfish-fetch") {
    return { command, options: { urls: options("url") } };
  }
  if (command === "stats-api") {
    const optionsBody = {
      operation: option("operation", true),
      q: option("q"),
      class_name: option("class-name"),
      format_name: option("format-name"),
      source_id: option("source-id"),
      min_win_rate: option("min-win-rate"),
      rank_range: option("rank-range"),
      period: option("period"),
      min_games: integer("min-games", undefined),
      game_type: option("game-type"),
      mode: option("mode"),
      tavern_tier: integer("tavern-tier", undefined),
      limit: integer("limit", 50),
      offset: integer("offset", 0),
    };
    return { command, options: optionsBody };
  }
  throw new Error(`unsupported command: ${command}`);
}

function boundedAgentOutput(body) {
  if (command !== "youtube-transcript") return body;
  try {
    const payload = JSON.parse(body);
    const results = payload?.data?.results;
    if (!Array.isArray(results)) return body;
    for (const result of results) {
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        continue;
      }
      if (Array.isArray(result.segments)) {
        delete result.segments;
        result.segments_omitted_from_agent_output = true;
      }
    }
    return JSON.stringify(payload);
  } catch {
    return body;
  }
}

async function main() {
  if (command === "doctor") {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.text();
    process.stdout.write(`${body}\n`);
    process.exitCode = response.ok ? 0 : 1;
    return;
  }

  const response = await fetch(`${baseUrl}/v1/source`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-source-gateway-token": token,
    },
    body: JSON.stringify(requestBody()),
  });
  const body = await response.text();
  process.stdout.write(`${boundedAgentOutput(body)}\n`);
  process.exitCode = response.ok ? 0 : 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "research source request failed"}\n`,
  );
  process.exitCode = 1;
}
