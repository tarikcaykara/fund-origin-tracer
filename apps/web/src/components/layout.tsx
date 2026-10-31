import { ChevronDown, Menu, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { CommandPalette } from "@/components/command-palette.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Toaster } from "@/components/ui/sonner.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { useBreakpoint } from "@/hooks/use-breakpoint.ts";
import { cn } from "@/lib/utils.ts";
import { isPaletteShortcut } from "@/palette.ts";
import { PaletteProvider } from "@/palette-context.tsx";
import { isMacPlatform } from "@/platform.ts";
import { type Theme, useTheme } from "@/theme.tsx";

interface NavigationItem {
  to: string;
  label: string;
}

function ThemeMark() {
  return (
    <span
      aria-hidden="true"
      className="size-3.5 rounded-full border-[1.5px] border-muted-foreground"
      style={{ background: "linear-gradient(90deg, var(--muted-foreground) 50%, transparent 50%)" }}
    />
  );
}

function ThemeControl() {
  const { theme, resolved, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Color theme: ${resolved}. Change theme`}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 type-body-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ThemeMark />
          {resolved === "dark" ? "Dark" : "Light"}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileThemeControl() {
  const { theme, setTheme } = useTheme();

  return (
    <ToggleGroup
      type="single"
      value={theme}
      aria-label="Color theme"
      onValueChange={(value) => {
        if (value === "light" || value === "dark" || value === "system") setTheme(value);
      }}
    >
      <ToggleGroupItem value="light">Light</ToggleGroupItem>
      <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
      <ToggleGroupItem value="system">System</ToggleGroupItem>
    </ToggleGroup>
  );
}

function navigationItems(pathname: string): NavigationItem[] {
  const items: NavigationItem[] = [{ to: "/", label: "Home" }];
  const runMatch = pathname.match(/^\/runs\/([^/]+)/);

  if (runMatch) {
    const runPath = `/runs/${runMatch[1]}`;
    items.push(
      pathname.endsWith("/report")
        ? { to: `${runPath}/report`, label: "Evidence report" }
        : { to: runPath, label: "Investigation" },
    );
  }
  items.push({ to: "/runs", label: "History" });
  return items;
}

function NavItems({
  items,
  onNavigate,
  mobile = false,
}: {
  items: NavigationItem[];
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  return items.map((item) => (
    <NavLink
      key={item.to}
      to={item.to}
      end
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          mobile
            ? "flex min-h-12 items-center gap-2 px-4 type-body text-foreground"
            : "rounded-sm px-2 py-1 type-body font-normal text-muted-foreground hover:bg-muted hover:text-foreground",
          isActive &&
            (mobile
              ? "font-semibold shadow-[inset_3px_0_0_var(--foreground)]"
              : "bg-muted font-semibold text-foreground"),
        )
      }
    >
      {item.label}
      {mobile ? <span className="ml-auto text-faint-foreground">›</span> : null}
    </NavLink>
  ));
}

export function Layout() {
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === "phone";
  const items = navigationItems(pathname);

  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    setMenuOpen(false);
    setPaletteOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isPhone) setMenuOpen(false);
  }, [isPhone]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      // Ctrl+K would otherwise focus the browser's search bar.
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <PaletteProvider>
      <TooltipProvider>
        <div className="flex min-h-screen flex-col">
          {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: The shared-shell contract requires the explicit banner landmark. */}
          <header
            role="banner"
            className="relative z-30 border-b border-border bg-card print:hidden"
          >
            <div className="flex h-12 items-center gap-2 px-4 md:h-11 md:gap-7 md:px-5">
              <NavLink
                to="/"
                end
                className="shrink-0 font-mono text-[13px] font-semibold tracking-[-.01em] text-foreground md:text-sm"
              >
                fund-origin-tracer
              </NavLink>
              <nav aria-label="Primary navigation" className="hidden items-center gap-1 md:flex">
                <NavItems items={items} />
              </nav>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-keyshortcuts="Meta+K Control+K"
                className="hidden h-7 w-[280px] shrink-0 items-center gap-2 rounded-[4px] border border-border bg-background px-2.5 text-xs text-faint-foreground hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:flex"
              >
                <span>Search address, tx or label</span>
                <span className="flex-1" />
                <kbd className="rounded-[3px] border border-border-strong px-1 font-mono text-[11px] font-medium">
                  {isMacPlatform() ? "⌘K" : "Ctrl K"}
                </kbd>
              </button>
              <div className="hidden md:block">
                <ThemeControl />
              </div>
              {isPhone ? (
                <button
                  type="button"
                  aria-label={menuOpen ? "Close menu" : "Open menu"}
                  aria-expanded={menuOpen}
                  aria-controls="mobile-navigation"
                  className={cn(
                    "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                    menuOpen && "bg-muted",
                  )}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  {menuOpen ? (
                    <X aria-hidden="true" className="size-5" />
                  ) : (
                    <Menu aria-hidden="true" className="size-5" />
                  )}
                </button>
              ) : null}
            </div>
            {isPhone && menuOpen ? (
              <div className="fixed inset-x-0 bottom-0 top-12 z-40 bg-overlay">
                <button
                  type="button"
                  aria-label="Close navigation menu"
                  className="absolute inset-0 h-full w-full cursor-default bg-transparent"
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  id="mobile-navigation"
                  className="relative z-10 border-b border-border-strong bg-card py-2 shadow-popover"
                >
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center gap-2 px-4 type-body text-foreground"
                    onClick={() => {
                      setMenuOpen(false);
                      setPaletteOpen(true);
                    }}
                  >
                    <Search aria-hidden="true" className="size-4" />
                    Search
                  </button>
                  <div className="my-2 mx-4 h-px bg-border" />
                  <nav aria-label="Mobile navigation" className="flex flex-col">
                    <NavItems items={items} mobile onNavigate={() => setMenuOpen(false)} />
                  </nav>
                  <div className="my-2 mx-4 h-px bg-border" />
                  <div className="flex min-h-12 items-center gap-3 px-4 type-body text-muted-foreground">
                    <span>Theme</span>
                    <span className="flex-1" />
                    <MobileThemeControl />
                  </div>
                </div>
              </div>
            ) : null}
          </header>
          <main className="flex w-full min-w-0 flex-1 flex-col">
            <Outlet />
          </main>
          <footer
            data-app-footer
            className="border-t border-border bg-card px-5 py-3 text-center type-mono-sm text-muted-foreground"
          >
            Powered by Etherscan.io APIs · Tronscan · DefiLlama · OFAC SDN
          </footer>
        </div>
        <Toaster />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </TooltipProvider>
    </PaletteProvider>
  );
}
