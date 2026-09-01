import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

/**
 * Process settings needed by the Codex binary itself. Authentication and application credentials
 * are deliberately absent: a caller must opt in to any additional, task-scoped variable by name.
 */
const BASE_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export type CodexRuntimeProfile = {
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
};

export type CreateCodexRuntimeProfileOptions = {
  environment?: NodeJS.ProcessEnv;
  parentDirectory?: string;
  additionalEnvironmentKeys?: readonly string[];
};

export function buildCodexChildEnvironment(
  environment: NodeJS.ProcessEnv,
  options: {
    codexHome?: string;
    additionalEnvironmentKeys?: readonly string[];
  } = {},
): NodeJS.ProcessEnv {
  const allowedKeys = new Set<string>([
    ...BASE_ENVIRONMENT_KEYS,
    ...(options.additionalEnvironmentKeys ?? []),
  ]);
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = environment[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  if (options.codexHome) childEnvironment.CODEX_HOME = options.codexHome;
  return childEnvironment;
}

/** Create one task-owned profile. The returned disposer is safe to call more than once. */
export async function createCodexRuntimeProfile(
  options: CreateCodexRuntimeProfileOptions = {},
): Promise<CodexRuntimeProfile> {
  const parentDirectory = options.parentDirectory ?? tmpdir();
  const codexHome = await mkdtemp(join(parentDirectory, "openbot-codex-"));
  let disposed = false;

  try {
    await chmod(codexHome, PRIVATE_DIRECTORY_MODE);
    return {
      codexHome,
      environment: buildCodexChildEnvironment(
        options.environment ?? process.env,
        {
          codexHome,
          additionalEnvironmentKeys: options.additionalEnvironmentKeys,
        },
      ),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(codexHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(codexHome, { recursive: true, force: true });
    throw error;
  }
}
