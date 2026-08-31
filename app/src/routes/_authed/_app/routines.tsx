import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { RoutinesList } from "@/components/routines/routines-list";

/**
 * A person's own standing instructions: what runs on a schedule, and a switch to stop one.
 *
 * `_authed/_app`, not Admin: a routine is something anybody has, the same way a skill is — it is
 * scoped to the signed-in person on every read and write, not to the deployment.
 *
 * Creation remains conversational, while this page owns the operational controls a person needs
 * after creation: edit, pause/resume, run now, history and deletion.
 */
export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  return (
    <PageShell
      description="Задачи, которые сотрудники выполняют автоматически. Создавайте и изменяйте их прямо в диалоге."
      title="Расписание"
    >
      <RoutinesList />
    </PageShell>
  );
}
