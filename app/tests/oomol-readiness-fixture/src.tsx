import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OomolReadiness } from "@/components/plugins/oomol-readiness";
import type { PluginServer } from "@/lib/plugins/queries";
import "./styles.css";

const server: PluginServer = {
  id: "oomol-connector",
  title: "OOMOL Connector",
  vendor: "OOMOL",
  url: "https://connector.oomol.com/v1",
  summary: "",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: "2026-09-05T10:00:00Z",
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  withdrawn: [],
  tools: [
    "googledocs.get_document",
    "googlesheets.get_spreadsheet",
    "github.get_current_user",
    `${"long_provider_".repeat(4)}.read`,
  ].map((name) => ({
    serverId: "oomol-connector",
    name,
    ref: `oomol-connector/${name}`,
    description: "",
    inputSchema: {},
    effect: "write",
    grantedTo: [],
  })),
};

function Fixture() {
  const [state, setState] = useState("discovered");
  const [dark, setDark] = useState(false);
  const [action, setAction] = useState("");
  const current =
    state === "new"
      ? undefined
      : {
          ...server,
          hasCredential: state !== "missing-key",
          tools:
            state === "empty"
              ? []
              : server.tools.map((tool) => ({
                  ...tool,
                  grantedTo:
                    state === "callback-needed"
                      ? ["fixture-agent"]
                      : state === "unresolved-grants"
                        ? ["unresolved-agent"]
                        : [],
                })),
          lastError: state === "failed" ? "OOMOL rejected key (401)." : null,
          toolsRefreshedAt:
            state === "unchecked" ? null : server.toolsRefreshedAt,
        };
  return (
    <div className={dark ? "dark" : ""}>
      <main className="min-h-screen bg-background p-4 text-foreground">
        <div className="mx-auto max-w-2xl">
          <h1 className="font-semibold text-2xl">OOMOL Connector</h1>
          <div className="mt-4 flex flex-wrap gap-4">
            <label>
              Сценарий{" "}
              <select
                aria-label="Сценарий"
                className="bg-background"
                onChange={(event) => {
                  setState(event.target.value);
                  setAction("");
                }}
                value={state}
              >
                {[
                  "new",
                  "missing-key",
                  "unchecked",
                  "checking",
                  "failed",
                  "empty",
                  "discovered",
                  "callback-needed",
                  "unresolved-grants",
                  "roster-unavailable",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <input
                checked={dark}
                onChange={(event) => setDark(event.target.checked)}
                type="checkbox"
              />{" "}
              Тёмная тема
            </label>
          </div>
          <OomolReadiness
            agents={
              state === "roster-unavailable"
                ? undefined
                : [{ id: "fixture-agent", hasCallbackToken: false }]
            }
            botsMayCallBack={state !== "callback-needed"}
            onConfigure={() =>
              setAction("Открывается существующий диалог ключа")
            }
            onGrant={() =>
              setAction("Открывается существующий диалог выбора прав")
            }
            onRefresh={() => {
              setState("checking");
              setTimeout(() => setState("discovered"), 300);
            }}
            refreshing={state === "checking"}
            server={current}
          />
          <p className="mt-4 text-sm">{action}</p>
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
