import { IconCheck, IconExternalLink, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  decideGoogleDocumentEditMutationOptions,
  type GoogleDocumentEdit,
  googleDocumentEditQueryOptions,
} from "@/lib/editor/google-document-edits";

export const Route = createFileRoute(
  "/_authed/_app/editor/google-doc-edits/$id",
)({ component: GoogleDocumentEditPage });

const stateCopy: Record<
  GoogleDocumentEdit["state"],
  { title: string; description: string }
> = {
  pending: {
    title: "Правка готова к сохранению",
    description:
      "Проверьте изменения ниже. Google Docs изменится только после нажатия кнопки.",
  },
  dispatching: {
    title: "Сохраняем в Google Docs",
    description: "Не закрывайте страницу: выполняется одна атомарная операция.",
  },
  succeeded: {
    title: "Правка сохранена",
    description: "Все подтверждённые изменения применены одной операцией.",
  },
  not_applied: {
    title: "Правка не применена",
    description:
      "Документ, доступ или правило безопасности изменились. Ничего не было записано — попросите редактора проверить свежую версию.",
  },
  ambiguous: {
    title: "Нужно проверить документ",
    description:
      "Google не подтвердил итог записи. Повторная отправка отключена, чтобы не продублировать изменения.",
  },
  expired: {
    title: "Срок подтверждения истёк",
    description: "Попросите редактора заново прочитать актуальный документ.",
  },
  declined: {
    title: "Правка отменена",
    description: "Google Docs не изменялся.",
  },
  superseded: {
    title: "Есть более новая правка",
    description: "Откройте последнюю ссылку, которую прислал редактор.",
  },
};

function GoogleDocumentEditPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const edit = useQuery(googleDocumentEditQueryOptions(id));
  const decision = useMutation(
    decideGoogleDocumentEditMutationOptions(queryClient, id),
  );

  if (edit.isPending) {
    return (
      <PageShell
        title="Загружаем правку"
        description="Получаем точный diff с сервера."
      >
        <div />
      </PageShell>
    );
  }
  if (edit.isError || !edit.data) {
    return (
      <PageShell
        title="Правка недоступна"
        description={
          edit.error?.message ??
          "Она не существует или принадлежит другому пользователю."
        }
      >
        <div />
      </PageShell>
    );
  }

  const value = edit.data;
  const copy = stateCopy[value.state];
  const pending = value.state === "pending";
  return (
    <PageShell
      title={copy.title}
      description={copy.description}
      action={
        <Button
          variant="outline"
          render={
            <a
              href={`https://docs.google.com/document/d/${encodeURIComponent(value.documentId)}/edit`}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          Открыть документ
          <IconExternalLink />
        </Button>
      }
    >
      <div className="mt-8 flex flex-col gap-5">
        {value.edits.map((change, index) => (
          <section
            className="overflow-hidden rounded-lg border bg-card"
            key={change.position}
          >
            <div className="border-b px-4 py-2 font-medium text-sm">
              Изменение {index + 1}
            </div>
            <div className="grid gap-px bg-border sm:grid-cols-2">
              <div className="bg-background p-4">
                <p className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
                  Было
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {change.before}
                </p>
              </div>
              <div className="bg-background p-4">
                <p className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
                  Стало
                </p>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {change.after}
                </p>
              </div>
            </div>
          </section>
        ))}
      </div>

      {pending ? (
        <div className="mt-8 flex flex-wrap gap-3">
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate("approve")}
          >
            <IconCheck />
            Сохранить в Google Docs
          </Button>
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate("decline")}
            variant="outline"
          >
            <IconX />
            Отменить
          </Button>
        </div>
      ) : null}
      {decision.isError ? (
        <p className="mt-4 text-destructive text-sm">
          {decision.error.message}
        </p>
      ) : null}
    </PageShell>
  );
}
