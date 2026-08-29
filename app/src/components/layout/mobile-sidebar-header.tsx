import { SidebarTrigger } from "@/components/ui/sidebar";

export function MobileSidebarHeader({ title }: { title: string }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:hidden">
      <SidebarTrigger aria-label="Открыть меню" className="-ml-1" />
      <span className="truncate font-semibold text-sm">{title}</span>
    </header>
  );
}
