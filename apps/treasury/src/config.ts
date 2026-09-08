type ClientEnvironment = {
  readonly VITE_AURKA_TREASURY_URL?: string;
  readonly VITE_AURKA_TRADER_URL?: string;
};

const environment = import.meta.env as ClientEnvironment;

function configuredUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function localSiblingUrl(port: string): string {
  if (typeof window === "undefined") return "/";
  const url = new URL(window.location.href);
  url.port = port;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Cross-app links are environment-configurable. During Vite development they
 * follow the current host and the two documented local app ports. A hosted
 * deployment should provide the VITE_* URLs, or serve the apps below the
 * conventional /treasury and /trader paths.
 */
export const appLinks = {
  treasury:
    configuredUrl(environment.VITE_AURKA_TREASURY_URL) ??
    (import.meta.env.DEV ? localSiblingUrl("3001") : "/treasury/"),
  trader:
    configuredUrl(environment.VITE_AURKA_TRADER_URL) ??
    (import.meta.env.DEV ? localSiblingUrl("3002") : "/trader/"),
} as const;
