import { NavLink, Outlet } from "react-router";
import { Toaster } from "@/components/ui/sonner.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

function NavItem({ to, children, end }: { to: string; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      className={({ isActive }) =>
        cn("text-sm", isActive ? "font-medium text-foreground" : "text-muted-foreground")
      }
    >
      {children}
    </NavLink>
  );
}

export function Layout() {
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
        <header className="border-b print:hidden">
          <nav className="mx-auto flex max-w-screen-2xl items-center gap-6 px-4 py-3">
            <span className="font-semibold">fund-origin-tracer</span>
            <NavItem to="/" end>
              Home
            </NavItem>
            <NavItem to="/runs">History</NavItem>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-6">
          <Outlet />
        </main>
        <footer className="border-t px-4 py-3 text-center text-xs text-muted-foreground print:hidden">
          Powered by Etherscan.io APIs · Tronscan · DefiLlama · OFAC SDN
        </footer>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
