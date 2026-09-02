import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** A tool one server offers, as the Plugins page sees it. */
export type PluginTool = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names. */
  ref: string;
  /** Whether it changes something. Anything not positively known to be a read is a write. */
  effect: "read" | "write";
  grantedTo: string[];
};

/**
 * A grant on a tool this server does not currently advertise.
 *
 * Held and not offered: nothing reaches a model, because a Bot is told about a tool only when the
 * grant and the tool list agree. That is a fact about what the vendor advertises today, not about the
 * grant, so it is reported rather than quietly dropped — a connector that starts advertising the name
 * again offers it again.
 */
export type WithdrawnGrant = {
  /** `<serverId>/<toolName>`. What a grant names, and what an administrator revokes. */
  ref: string;
  name: string;
  grantedTo: string[];
};

export type PluginServer = {
  id: string;
  title: string;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` for a reviewed entry, `custom` for one an administrator added by URL. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  /**
   * Whether this server registers its own OAuth client (RFC 7591) rather than waiting on an
   * administrator to paste one in.
   */
  dynamicClient: boolean;
  tools: PluginTool[];
  /** Empty for a healthy connector. See {@link WithdrawnGrant}. */
  withdrawn: WithdrawnGrant[];
};

export type PluginSkill = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's: an administrator looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * A declaration, not a grant, and the difference is the whole reason anybody may write a skill:
   * naming a tool here cannot make it callable. Selection intersects this with what the Bot was
   * granted, so a skill naming a tool its Bot does not hold selects the skill and loads nothing.
   * `grantedTo` on the tool side is what decides.
   */
  tools: string[];
};

export type CatalogueItem = {
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  /**
   * Whose credential reaches this server.
   *
   * `deployment-bearer` is a token an administrator holds for everybody, and the only one this page
   * can collect. `user-oauth` is reached as whoever is asking, so each person connects their own
   * account and there is no token to type here. `builtin` is a first-party capability that runs
   * inside this deployment — there is nothing to connect and nothing to type.
   */
  auth: "none" | "deployment-bearer" | "user-oauth" | "builtin";
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
  /**
   * Whether a Bot holding no credential of its own can still call a tool back.
   *
   * True when the deployment has a shared secret configured for it. A grant decides whether a tool
   * is offered to a model at all; this decides whether the call it makes can be authenticated. With
   * neither this nor a credential issued to the Bot, every call is refused before it reaches the
   * grant, the boundary or the audit trail, which is not something a grant switch can show.
   */
  botsMayCallBack: boolean;
  /**
   * The redirect URI to register with a `user-oauth` vendor, exactly as this deployment will send it.
   *
   * From the server rather than assembled here, because it has to match what was registered
   * character for character. Null when the deployment has no public URL and so cannot complete a
   * consent flow at all.
   */
  redirectUri: string | null;
};

/** What one Bot holds, which is all the runtime needs to offer it. */
export type GrantedPlugins = {
  tools: {
    ref: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }[];
};

export const pluginKeys = {
  all: ["plugins"] as const,
  page: () => ["plugins", "page"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
  connections: () => ["plugins", "connections"] as const,
  connectionHealth: () => ["plugins", "connection-health"] as const,
};

/** One account this person has connected, from their own point of view. */
export type PluginConnection = {
  serverId: string;
  /** What the vendor actually granted, which is not always what was asked for. */
  scope: string;
  connectedAt: string;
};

export type PluginConnections = {
  connections: PluginConnection[];
  redirectUri: string | null;
};

function connectionRows(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(
    (row) => Boolean(row) && typeof row === "object" && !Array.isArray(row),
  )
    ? (value as Record<string, unknown>[])
    : null;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Project the personal connection response before it reaches settings or admin UI state. */
export function projectPluginConnections(value: unknown): PluginConnections {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin connections returned an invalid response");
  }
  const source = value as Record<string, unknown>;
  const connections = connectionRows(source.connections);
  if (
    !connections ||
    (source.redirectUri !== null && typeof source.redirectUri !== "string")
  ) {
    throw new Error("Plugin connections returned an invalid response");
  }

  const projected = connections.map((row) => ({
    serverId: row.serverId,
    scope: row.scope,
    connectedAt: row.connectedAt,
  }));
  if (
    projected.some(
      (row) =>
        typeof row.serverId !== "string" ||
        row.serverId.length === 0 ||
        typeof row.scope !== "string" ||
        !validTimestamp(row.connectedAt),
    )
  ) {
    throw new Error("Plugin connections returned an invalid response");
  }

  return {
    connections: projected.map((row) => ({
      serverId: row.serverId as string,
      scope: row.scope as string,
      connectedAt: row.connectedAt as string,
    })),
    redirectUri: source.redirectUri as string | null,
  };
}

export type PluginConnectionHealth = {
  available: { serverId: string; title: string }[];
  connected: { serverId: string; connectedAt: string }[];
};

/**
 * The signed-in person's own connections.
 *
 * There is no version of this scoped to anybody else: the endpoint answers for whoever is asking,
 * so a page cannot accidentally render somebody else's.
 */
export function connectionsQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.connections(),
    queryFn: async (): Promise<PluginConnections> => {
      const response = await client("/api/plugins/connections", {
        fallback: "Your connected accounts could not be loaded.",
      });
      return projectPluginConnections(await response.json());
    },
    staleTime: 30_000,
  });
}

export function projectPluginConnectionHealth(
  value: unknown,
): PluginConnectionHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin connection health returned an invalid response");
  }
  const source = value as Record<string, unknown>;
  const rows = (candidate: unknown): Record<string, unknown>[] | null => {
    if (!Array.isArray(candidate)) return null;
    return candidate.every(
      (row) => Boolean(row) && typeof row === "object" && !Array.isArray(row),
    )
      ? (candidate as Record<string, unknown>[])
      : null;
  };
  const available = rows(source.available)?.map((row) => ({
    serverId: row.serverId,
    title: row.title,
  }));
  const connected = rows(source.connected)?.map((row) => ({
    serverId: row.serverId,
    connectedAt: row.connectedAt,
  }));
  if (
    !available ||
    !connected ||
    available.some(
      (row) =>
        typeof row.serverId !== "string" || typeof row.title !== "string",
    ) ||
    connected.some(
      (row) =>
        typeof row.serverId !== "string" || typeof row.connectedAt !== "string",
    )
  ) {
    throw new Error("Plugin connection health returned an invalid response");
  }
  return {
    available: available.map((row) => ({
      serverId: row.serverId as string,
      title: row.title as string,
    })),
    connected: connected.map((row) => ({
      serverId: row.serverId as string,
      connectedAt: row.connectedAt as string,
    })),
  };
}

export function pluginConnectionHealthQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.connectionHealth(),
    queryFn: async (): Promise<PluginConnectionHealth> => {
      const response = await client("/api/plugins/health", {
        fallback: "Plugin connection health could not be loaded.",
      });
      return projectPluginConnectionHealth(await response.json());
    },
    staleTime: 30_000,
  });
}

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await client("/api/plugins", {
        fallback: "Plugins could not be loaded.",
      });
      return response.json();
    },
  });
}

/**
 * Polled grant snapshot for what the active Bot should be offered; call-time checks still enforce.
 */
export function agentPluginsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId),
    enabled: agentId.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<GrantedPlugins> => {
      const response = await client(
        `/api/plugins/for/${encodeURIComponent(agentId)}`,
        { fallback: "This Bot's plugins could not be read." },
      );
      return response.json();
    },
  });
}
