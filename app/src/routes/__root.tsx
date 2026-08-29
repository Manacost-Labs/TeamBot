import {
  createRootRouteWithContext,
  type ErrorComponentProps,
  Outlet,
} from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RouterContext } from "../router-context";
import "@fontsource-variable/inter/wght.css";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});

function RecoveryPage({
  title,
  description,
  retry,
}: {
  title: string;
  description: string;
  retry?: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="font-semibold text-xl">{title}</h1>
        <p className="mt-2 text-muted-foreground text-sm">{description}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {retry ? (
            <button
              className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm"
              onClick={retry}
              type="button"
            >
              Попробовать снова
            </button>
          ) : null}
          <a
            className="rounded-md border px-4 py-2 font-medium text-sm"
            href="/"
          >
            На главную
          </a>
        </div>
      </section>
    </main>
  );
}

function RootError({ reset }: ErrorComponentProps) {
  return (
    <RecoveryPage
      description="Страница не смогла загрузиться. Повторите попытку — ваши данные и диалоги сохранятся."
      retry={reset}
      title="Не удалось открыть страницу"
    />
  );
}

function NotFound() {
  return (
    <RecoveryPage
      description="Возможно, ссылка устарела или адрес был введён с ошибкой."
      title="Страница не найдена"
    />
  );
}

function RootComponent() {
  return (
    <div className="min-h-dvh w-full antialiased">
      <ThemeProvider>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </ThemeProvider>
    </div>
  );
}
