export function PageLoading({ label = "Загрузка…" }: { label?: string }) {
  return (
    <div
      className="flex min-h-32 flex-1 items-center justify-center p-6 text-muted-foreground"
      role="status"
    >
      <span
        aria-hidden="true"
        className="mr-2 size-2 animate-pulse rounded-full bg-current motion-reduce:animate-none"
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}
