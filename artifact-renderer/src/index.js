import { chromium } from "playwright";

import { createPdfRenderer } from "./renderer.js";
import { createArtifactServer } from "./server.js";

const token = process.env.ARTIFACT_RENDERER_TOKEN;
const configuredPort = Number(process.env.PORT ?? "8080");

if (!token) throw new Error("ARTIFACT_RENDERER_TOKEN is required");
if (
  !Number.isInteger(configuredPort) ||
  configuredPort < 1 ||
  configuredPort > 65_535
) {
  throw new Error("PORT is invalid");
}

const browser = await chromium.launch({ headless: true });
const server = createArtifactServer({
  token,
  render: createPdfRenderer(browser),
});

async function shutdown() {
  server.closeIdleConnections();
  await new Promise((resolve) => server.close(resolve));
  await browser.close();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

server.listen(configuredPort, "0.0.0.0");
