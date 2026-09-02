import { Component, type ErrorInfo, type ReactNode } from "react";

type RuntimeErrorBoundaryProps = {
  children: ReactNode;
};

type RuntimeErrorBoundaryState = {
  incidentId: string | null;
};

function createIncidentId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ui-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }
}

/**
 * Keeps one rendering failure from taking the whole workspace down.
 *
 * The boundary intentionally shows no exception text: a model response or document title can end
 * up in an error message, and copying it into a global fallback would leak it outside its normal
 * access boundary. The incident id is safe to share with support and is the correlation point for
 * the structured console event until a deployment wires a remote error sink.
 */
export class RuntimeErrorBoundary extends Component<
  RuntimeErrorBoundaryProps,
  RuntimeErrorBoundaryState
> {
  state: RuntimeErrorBoundaryState = { incidentId: null };

  static getDerivedStateFromError(): RuntimeErrorBoundaryState {
    return { incidentId: createIncidentId() };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("[runtime] ui-render-error", {
      type: "ui-render-error",
      incidentId: this.state.incidentId,
      errorName,
      componentStackPresent: Boolean(info.componentStack),
    });
  }

  private readonly retry = (): void => {
    this.setState({ incidentId: null });
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.incidentId) return this.props.children;

    return (
      <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <section
          aria-labelledby="runtime-error-title"
          className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm"
          role="alert"
        >
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Ошибка интерфейса
          </p>
          <h1 className="mt-2 font-semibold text-xl" id="runtime-error-title">
            Приложение временно недоступно
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            Рабочая сессия сохранена. Повторите попытку или перезагрузите
            страницу.
          </p>
          <p className="mt-3 font-mono text-muted-foreground text-xs">
            Код: {this.state.incidentId}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm"
              onClick={this.retry}
              type="button"
            >
              Повторить
            </button>
            <button
              className="rounded-md border px-4 py-2 font-medium text-sm"
              onClick={this.reload}
              type="button"
            >
              Перезагрузить
            </button>
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
}
