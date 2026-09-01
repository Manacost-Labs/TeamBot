import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENVIRONMENT_KEY = "OPENROUTER_API_KEY";

const OPENROUTER_CONFIG = `model_provider = "manacost_openrouter"

[model_providers.manacost_openrouter]
name = "OpenRouter"
base_url = "${OPENROUTER_BASE_URL}"
wire_api = "responses"
env_key = "${OPENROUTER_API_KEY_ENVIRONMENT_KEY}"
requires_openai_auth = false

[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false
exclude = ["${OPENROUTER_API_KEY_ENVIRONMENT_KEY}"]
`;

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

export type CreateOpenRouterRuntimeProfileOptions = Omit<
  CreateCodexRuntimeProfileOptions,
  "additionalEnvironmentKeys"
> & {
  apiKey: string;
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

/**
 * Create the fixed OpenRouter provider understood by the installed Codex CLI.
 *
 * The secret stays in the Codex process environment because `env_key` is how the provider reads
 * it. The generated shell policy removes that same variable from every command Codex starts. No
 * base URL, wire protocol or additional config is accepted from run/browser input.
 */
export async function createOpenRouterRuntimeProfile(
  options: CreateOpenRouterRuntimeProfileOptions,
): Promise<CodexRuntimeProfile> {
  if (!options.apiKey.trim()) {
    throw new Error("An OpenRouter API key is required.");
  }

  const profile = await createCodexRuntimeProfile({
    environment: options.environment,
    parentDirectory: options.parentDirectory,
  });
  try {
    const configPath = join(profile.codexHome, "config.toml");
    await writeFile(configPath, OPENROUTER_CONFIG, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(configPath, PRIVATE_FILE_MODE);
    return {
      ...profile,
      environment: {
        ...profile.environment,
        [OPENROUTER_API_KEY_ENVIRONMENT_KEY]: options.apiKey.trim(),
      },
    };
  } catch (error) {
    await profile.dispose();
    throw error;
  }
}
