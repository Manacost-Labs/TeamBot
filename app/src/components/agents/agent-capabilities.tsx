import { IconBrandGoogleDrive, IconExternalLink } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  grantPlugin,
  invalidatePlugins,
  revokePlugin,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  type PluginTool,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

const GOOGLE_GROUPS: ReadonlyArray<{
  title: string;
  description: string;
  names: ReadonlySet<string>;
}> = [
  {
    title: "Google Drive — чтение",
    description: "Поиск, список папок, метаданные, чтение и экспорт файлов.",
    names: new Set([
      "search_files",
      "list_recent_files",
      "list_folder",
      "get_file_metadata",
      "read_file_content",
      "export_file",
    ]),
  },
  {
    title: "Google Docs — чтение",
    description:
      "Чтение документа и безопасной карты его редактируемых диапазонов.",
    names: new Set(["read_google_document", "read_google_document_edit_map"]),
  },
  {
    title: "Google Docs — запись",
    description: "Создание, дополнение и изменение диапазонов документов.",
    names: new Set([
      "create_google_doc",
      "append_google_doc",
      "replace_google_doc_range",
    ]),
  },
  {
    title: "Google Sheets — чтение",
    description: "Метаданные, вкладки и чтение диапазонов таблицы.",
    names: new Set([
      "get_google_sheet_metadata",
      "list_google_sheet_tabs",
      "read_google_sheet_range",
    ]),
  },
  {
    title: "Google Sheets — запись",
    description:
      "Создание таблиц и вкладок, добавление, изменение и очистка строк.",
    names: new Set([
      "create_google_spreadsheet",
      "create_google_sheet_tab",
      "append_google_sheet_rows",
      "update_google_sheet_range",
      "clear_google_sheet_range",
    ]),
  },
] as const;

function PermissionRow({
  title,
  description,
  checked,
  partial = false,
  disabled,
  pending,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  partial?: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          {description}
          {partial ? " Часть действий уже разрешена." : ""}
        </p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled || pending}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/**
 * Permissions and knowledge connections for one coworker.
 *
 * The role text is deliberately absent here: prose never grants a tool. Every switch writes the
 * existing server-side grant and the runtime still rechecks it, policy and the user's OAuth token
 * at call time.
 */
export function AgentCapabilities({
  agentId,
  mine,
}: {
  agentId: string;
  mine: boolean;
}) {
  const queryClient = useQueryClient();
  const currentUser = useQuery(currentUserQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const isAdmin = currentUser.data?.role === "admin";

  const update = useMutation({
    mutationFn: async ({
      kind,
      refs,
      granted,
    }: {
      kind: "mcp" | "skill";
      refs: string[];
      granted: boolean;
    }) => {
      for (const ref of refs) {
        const write = granted ? grantPlugin : revokePlugin;
        await write({ agentId, kind, ref });
      }
    },
    onSettled: () => invalidatePlugins(queryClient),
  });

  if (plugins.isPending || connections.isPending || currentUser.isPending) {
    return (
      <p className="text-sm text-muted-foreground">Загружаем разрешения…</p>
    );
  }
  if (plugins.error || connections.error || currentUser.error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Не удалось загрузить разрешения и подключения сотрудника. Обновите
        страницу и попробуйте снова.
      </p>
    );
  }

  const google = plugins.data?.servers.find(
    (server) => server.id === "google-drive",
  );
  const connected = connections.data?.connections.some(
    (connection) => connection.serverId === "google-drive",
  );
  const skills = plugins.data?.skills ?? [];

  const changeGroup = (
    kind: "mcp" | "skill",
    tools: Array<Pick<PluginTool, "ref">>,
    granted: boolean,
  ) => {
    update.mutate({ kind, refs: tools.map((tool) => tool.ref), granted });
  };

  return (
    <div className="grid gap-6">
      <section>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Знания и Google Workspace</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Сотрудник работает только с аккаунтом пользователя, который начал
              запрос. Текст роли не выдаёт доступ.
            </p>
          </div>
          <Button
            render={<Link to="/settings/connected-accounts" />}
            size="sm"
            variant="outline"
          >
            <IconBrandGoogleDrive className="size-4" />
            {connected ? "Google подключён" : "Подключить Google"}
            <IconExternalLink className="size-3.5" />
          </Button>
        </div>

        {!google ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Google Workspace ещё не включён администратором рабочего
            пространства.
          </p>
        ) : (
          <div className="mt-3 rounded-lg border border-border px-4">
            {GOOGLE_GROUPS.map((group) => {
              const tools = google.tools.filter((tool) =>
                group.names.has(tool.name),
              );
              const held = tools.filter((tool) =>
                tool.grantedTo.includes(agentId),
              ).length;
              return (
                <PermissionRow
                  checked={tools.length > 0 && held === tools.length}
                  description={group.description}
                  disabled={(!isAdmin && !mine) || tools.length === 0}
                  key={group.title}
                  onChange={(granted) => changeGroup("mcp", tools, granted)}
                  partial={held > 0 && held < tools.length}
                  pending={update.isPending}
                  title={group.title}
                />
              );
            })}
          </div>
        )}
        {!isAdmin && google && !mine ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Подключить свой Google‑аккаунт можете вы; доступ чужого сотрудника
            меняет только его владелец или администратор.
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="text-sm font-medium">Навыки</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Навык добавляет инструкции, но не расширяет разрешения инструментов.
        </p>
        {skills.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Доступных навыков пока нет.
          </p>
        ) : (
          <div className="mt-3 rounded-lg border border-border px-4">
            {skills.map((skill) => {
              const held = skill.grantedTo.includes(agentId);
              const canChange =
                isAdmin || (mine && skill.ownerUserId === currentUser.data?.id);
              return (
                <PermissionRow
                  checked={held}
                  description={skill.summary || `Команда /${skill.slug}`}
                  disabled={!canChange}
                  key={skill.slug}
                  onChange={(granted) =>
                    update.mutate({
                      kind: "skill",
                      refs: [skill.slug],
                      granted,
                    })
                  }
                  pending={update.isPending}
                  title={`/${skill.slug} · ${skill.title}`}
                />
              );
            })}
          </div>
        )}
      </section>

      {isAdmin ? (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Все инструменты и MCP‑доступ
          </summary>
          <div className="mt-3 grid gap-4">
            {(plugins.data?.servers ?? [])
              .filter((server) => server.id !== "google-drive")
              .map((server) => (
                <div key={server.id}>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {server.title}
                  </p>
                  {server.tools.map((tool) => (
                    <PermissionRow
                      checked={tool.grantedTo.includes(agentId)}
                      description={`${tool.effect === "write" ? "Запись" : "Чтение"}. ${tool.description}`}
                      disabled={false}
                      key={tool.ref}
                      onChange={(granted) =>
                        changeGroup("mcp", [tool], granted)
                      }
                      pending={update.isPending}
                      title={tool.name}
                    />
                  ))}
                </div>
              ))}
          </div>
        </details>
      ) : null}

      {update.error ? (
        <p className="text-sm text-destructive" role="alert">
          {update.error.message}
        </p>
      ) : null}
    </div>
  );
}
