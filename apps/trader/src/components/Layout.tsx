import { Link, useLocation } from "react-router-dom";
import { Home, ArrowLeftRight, Wallet, Clock } from "lucide-react";
import { clsx } from "clsx";

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();

  const navigation = [
    { name: "Dashboard", href: "/", icon: Home },
    { name: "Trade", href: "/trade", icon: ArrowLeftRight },
    { name: "Portfolio", href: "/portfolio", icon: Wallet },
    { name: "History", href: "/history", icon: Clock },
  ];

  return (
    <div className="min-h-screen bg-gray-900">
      <nav className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between min-h-16">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <h1 className="text-white font-bold text-xl">AURKA Trader</h1>
              </div>
              <div className="block">
                <div className="flex flex-wrap items-baseline gap-2">
                  {navigation.map((item) => {
                    const isActive = location.pathname === item.href;
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className={clsx(
                          isActive
                            ? "bg-gray-900 text-white"
                            : "text-gray-300 hover:bg-gray-700 hover:text-white",
                          "px-3 py-2 rounded-md text-sm font-medium flex items-center gap-2",
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
