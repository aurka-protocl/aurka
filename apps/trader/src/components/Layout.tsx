import { Link, useLocation } from "react-router-dom";
import {
  Activity,
  ArrowLeftRight,
  CircleHelp,
  ExternalLink,
  Home,
  ShieldCheck,
} from "lucide-react";
import { clsx } from "clsx";
import { appLinks } from "../config";

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();

  const navigation = [
    { name: "Start here", href: "/", icon: Home },
    { name: "Swap", href: "/swap", icon: ArrowLeftRight },
    { name: "Swap activity", href: "/activity", icon: Activity },
    { name: "System status", href: "/status", icon: ShieldCheck },
  ];

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-950/95">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link to="/" className="group shrink-0" aria-label="AURKA start here">
            <span className="block text-lg font-bold tracking-[0.2em] text-white">
              AURKA
            </span>
            <span className="block text-xs text-slate-500">Trader space</span>
          </Link>
          <nav
            aria-label="Primary navigation"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          >
            {navigation.map((item) => {
              const isActive =
                item.href === "/"
                  ? location.pathname === "/" || location.pathname === "/start"
                  : location.pathname === item.href ||
                    location.pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={clsx(
                    isActive
                      ? "bg-slate-800 text-white"
                      : "text-slate-300 hover:bg-slate-800 hover:text-white",
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                  )}
                >
                  <item.icon className="h-4 w-4" aria-hidden="true" />
                  {item.name}
                </Link>
              );
            })}
            <a
              href={appLinks.treasury}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Treasury space
            </a>
          </nav>
          <span className="flex items-center gap-2 text-xs text-slate-500">
            <CircleHelp className="h-4 w-4" aria-hidden="true" />
            No wallet connected
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
