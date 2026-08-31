import { createPdfExtractorServer } from "./server.js";

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT is invalid");
}

const server = createPdfExtractorServer();

function shutdown() {
  server.closeIdleConnections();
  server.close();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(port, "0.0.0.0");
