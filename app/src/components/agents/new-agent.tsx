import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AgentFields } from "@/components/agents/agent-fields";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentInputFrom } from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { AGENT_TEMPLATES, agentTemplateValues } from "@/lib/agents/templates";
import { currentUserQueryOptions } from "@/lib/auth/queries";

export function NewAgent() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  const currentUser = useQuery(currentUserQueryOptions());
  const [templateId, setTemplateId] = useState("blank");

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Новый сотрудник</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Эта роль будет действовать во всех диалогах сотрудника.
        </p>
      </header>

      <section className="grid gap-2 rounded-lg border border-border p-4">
        <label className="text-sm font-medium" htmlFor="agent-template">
          Шаблон
        </label>
        <Select
          onValueChange={(value) => setTemplateId(value ?? "blank")}
          value={templateId}
        >
          <SelectTrigger id="agent-template">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="blank">С нуля</SelectItem>
              {AGENT_TEMPLATES.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.label} — {template.description}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Шаблон заполняет роль и настройки. Разрешения и подключения всегда
          выдаются отдельно.
        </p>
      </section>

      <AgentFields
        allowCustomModel={currentUser.data?.role === "admin"}
        defaultValues={agentTemplateValues(templateId)}
        error={createAgent.error}
        key={templateId}
        onSubmit={async (values) => {
          // The panel swaps from the form to the new coworker's profile, and the roster behind it
          // picks up the new card: the next thing to do is start a channel with it.
          const agent = await createAgent.mutateAsync(agentInputFrom(values));
          await navigate({ search: { agent: agent.id }, to: "/agents" });
        }}
        submitLabel="Создать сотрудника"
      />
    </div>
  );
}
