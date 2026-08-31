import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type AgentFormValues, agentFormSchema } from "@/lib/agents/form";
import {
  type ConnectionVerdict,
  testAgentConnection,
} from "@/lib/agents/queries";

const SELECTABLE_MODELS = new Set([
  "",
  "account-default",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
]);

export function AgentFields({
  defaultValues,
  hasAuth = false,
  submitLabel,
  onSubmit,
  error,
  onCancel,
  allowCustomModel = false,
}: {
  defaultValues: AgentFormValues;
  /** Whether this coworker already has a key, so the field can say so without showing it. */
  hasAuth?: boolean;
  submitLabel: string;
  onSubmit: (values: AgentFormValues) => Promise<unknown>;
  error?: Error | null;
  onCancel?: () => void;
  /** Custom provider identifiers are intentionally an administrator-only control. */
  allowCustomModel?: boolean;
}) {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: agentFormSchema },
    onSubmit: async ({ value }) => {
      await onSubmit(value);
    },
  });

  const [connection, setConnection] = useState<ConnectionVerdict | null>(null);
  const [testing, setTesting] = useState(false);
  const [customModel, setCustomModel] = useState(
    !SELECTABLE_MODELS.has(defaultValues.model),
  );

  /** Test endpoint reachability from the server, which is what runs will use. */
  const testConnection = async (endpoint: string, key: string) => {
    setTesting(true);
    setConnection(null);
    try {
      setConnection(await testAgentConnection(endpoint, key));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="name">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Имя</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Контроль данных"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="title">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Должность</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Специалист по данным"
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="roleDescription">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Роль</FieldLabel>
                <Textarea
                  aria-invalid={isInvalid}
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Опишите задачи, ответственность и правила работы сотрудника."
                  rows={4}
                  value={field.state.value}
                />
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="model">
          {(field) => {
            const custom =
              customModel || !SELECTABLE_MODELS.has(field.state.value);
            return (
              <Field>
                <FieldLabel htmlFor={field.name}>Модель</FieldLabel>
                <Select
                  onValueChange={(value) => {
                    if (value === null) return;
                    if (value === "custom") {
                      setCustomModel(true);
                      if (SELECTABLE_MODELS.has(field.state.value)) {
                        field.handleChange("");
                      }
                      return;
                    }
                    setCustomModel(false);
                    field.handleChange(value === "default" ? "" : value);
                  }}
                  value={custom ? "custom" : field.state.value || "default"}
                >
                  <SelectTrigger id={field.name}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="default">
                        По умолчанию для рабочего пространства
                      </SelectItem>
                      <SelectItem value="account-default">
                        Модель ChatGPT аккаунта
                      </SelectItem>
                      <SelectItem value="gpt-5.6-luna">GPT-5.6 Luna</SelectItem>
                      <SelectItem value="gpt-5.6-terra">
                        GPT-5.6 Terra
                      </SelectItem>
                      {allowCustomModel || custom ? (
                        <SelectItem value="custom">
                          {allowCustomModel
                            ? "Другая модель…"
                            : `Настроено администратором: ${field.state.value}`}
                        </SelectItem>
                      ) : null}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {custom && allowCustomModel ? (
                  <Input
                    aria-label="Идентификатор модели"
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="provider-model-id"
                    value={field.state.value}
                  />
                ) : null}
                <p className="text-muted-foreground text-sm">
                  Провайдер: OpenAI. Секреты модели задаются для рабочего
                  пространства и здесь не показываются.
                </p>
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="visibility">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Доступ</FieldLabel>
              <Select
                onValueChange={(value) =>
                  field.handleChange(value as AgentFormValues["visibility"])
                }
                value={field.state.value}
              >
                <SelectTrigger id={field.name}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="private">
                      Личный — виден только вам
                    </SelectItem>
                    <SelectItem value="public">
                      Общий — виден всем пользователям
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="endpoint">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>
                  Адрес агента (необязательно)
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    aria-invalid={isInvalid}
                    id={field.name}
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      setConnection(null);
                      field.handleChange(event.target.value);
                    }}
                    placeholder="https://your-agent.example.com/ag-ui"
                    value={field.state.value}
                  />
                  <Button
                    disabled={!field.state.value || testing}
                    onClick={() =>
                      void testConnection(
                        field.state.value,
                        form.getFieldValue("authValue") ?? "",
                      )
                    }
                    type="button"
                    variant="outline"
                  >
                    {testing ? "Проверяем…" : "Проверить"}
                  </Button>
                </div>
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
                {connection ? (
                  <p
                    className={`text-sm ${connection.ok ? "text-muted-foreground" : "text-destructive"}`}
                    role="status"
                  >
                    {connection.ok
                      ? `Ответ получен: ${connection.events.join(", ")}`
                      : connection.reason}
                  </p>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Оставьте пустым для встроенного сотрудника. Поддерживается
                    любой агент с протоколом AG-UI, доступный с этого сервера.
                  </p>
                )}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="authValue">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>
                Ключ агента (необязательно)
              </FieldLabel>
              <Input
                autoComplete="off"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={
                  hasAuth
                    ? "Ключ уже задан. Введите новый для замены."
                    : "Bearer …"
                }
                // Never repopulated; `hasAuth` communicates that a key exists without exposing it.
                type="password"
                value={field.state.value}
              />
              <p className="text-muted-foreground text-sm">
                Передаётся в заголовке <code>Authorization</code> и хранится в
                защищённом хранилище. Оставьте пустым, чтобы сохранить текущий
                ключ.
              </p>
            </Field>
          )}
        </form.Field>

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Расширенные настройки
          </summary>
          <div className="mt-4">
            <form.Field name="reasoningEffort">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>
                    Глубина рассуждения
                  </FieldLabel>
                  <Select
                    onValueChange={(value) =>
                      field.handleChange(
                        value === "default"
                          ? ""
                          : (value as AgentFormValues["reasoningEffort"]),
                      )
                    }
                    value={field.state.value || "default"}
                  >
                    <SelectTrigger id={field.name}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="default">
                          По умолчанию для рантайма
                        </SelectItem>
                        <SelectItem value="none">Без рассуждения</SelectItem>
                        <SelectItem value="minimal">Минимальная</SelectItem>
                        <SelectItem value="low">Низкая</SelectItem>
                        <SelectItem value="medium">Средняя</SelectItem>
                        <SelectItem value="high">Высокая</SelectItem>
                        <SelectItem value="xhigh">Очень высокая</SelectItem>
                        <SelectItem value="max">Максимальная</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-sm">
                    Ограниченное значение передаётся управляемому Codex‑агенту
                    отдельно от идентификатора модели.
                  </p>
                </Field>
              )}
            </form.Field>
          </div>
        </details>
      </FieldGroup>

      {error ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, isSubmitting]) => (
            <Button disabled={!canSubmit || isSubmitting} type="submit">
              {isSubmitting ? "Сохраняем…" : submitLabel}
            </Button>
          )}
        </form.Subscribe>
        {onCancel ? (
          <Button onClick={onCancel} type="button" variant="outline">
            Отмена
          </Button>
        ) : null}
      </div>
    </form>
  );
}
