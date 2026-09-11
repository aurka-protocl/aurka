import { useEffect, useState } from "react";
import { Menu, X, Activity, ArrowLeftRight, Boxes, Info } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { clsx } from "clsx";
import { environmentLabel, appMode } from "../config";
import { useWallet, WalletStateMessage, WalletStatusControl } from "../wallet";

interface LayoutProps {
  readonly children: React.ReactNode;
}

const navigation = [
  { name: "Spaces", href: "/spaces", icon: Boxes },
  { name: "Trade", href: "/trade", icon: ArrowLeftRight },
  { name: "Activity", href: "/activity", icon: Activity },
  { name: "About", href: "/about", icon: Info },
];

function navigationClass(active: boolean): string {
  return clsx(
    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
    active
      ? "bg-slate-800 text-white"
      : "text-slate-300 hover:bg-slate-800 hover:text-white",
  );
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const wallet = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-950/95">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <NavLink
            to="/spaces"
            className="group shrink-0"
            aria-label="AURKA Spaces"
          >
            <span className="block text-lg font-bold tracking-[0.2em] text-white">
              AURKA
            </span>
            <span className="block text-xs text-slate-500">
              Constrained liquidity
            </span>
          </NavLink>

          <nav
            aria-label="Primary navigation"
            className="hidden min-w-0 flex-1 items-center gap-1 md:flex"
          >
            {navigation.map((item) => (
              <NavLink
                key={item.name}
                to={item.href}
                end={item.href !== "/trade"}
                className={({ isActive }) => navigationClass(isActive)}
              >
                <item.icon className="h-4 w-4" aria-hidden="true" />
                {item.name}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-slate-800 px-2.5 py-1 text-[11px] text-slate-400 sm:inline-flex">
              <span
                className={clsx(
                  "h-1.5 w-1.5 rounded-full",
                  appMode === "fork" ? "bg-amber-300" : "bg-cyan-300",
                )}
                aria-hidden="true"
              />
              {environmentLabel}
            </span>
            <WalletStatusControl />
            <button
              type="button"
              className="rounded-lg border border-slate-700 p-2 text-slate-200 md:hidden"
              aria-label={
                menuOpen ? "Close navigation menu" : "Open navigation menu"
              }
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? (
                <X className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Menu className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="mobile-navigation"
            aria-label="Mobile navigation"
            className="border-t border-slate-800 px-4 py-3 md:hidden"
          >
            <div className="mx-auto grid max-w-7xl gap-1 sm:grid-cols-3">
              {navigation.map((item) => (
                <NavLink
                  key={item.name}
                  to={item.href}
                  end={item.href !== "/trade"}
                  className={({ isActive }) => navigationClass(isActive)}
                >
                  <item.icon className="h-4 w-4" aria-hidden="true" />
                  {item.name}
                </NavLink>
              ))}
            </div>
          </nav>
        )}
      </header>

      {(wallet.status === "wrong-network" ||
        wallet.status === "unsupported-network" ||
        wallet.status === "error") && (
        <div className="mx-auto max-w-7xl px-4 pt-3 sm:px-6 lg:px-8">
          <WalletStateMessage />
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {children}
      </main>
    </div>
  );
}
