type ClientEnvironment = {
  readonly VITE_AURKA_MODE?: string;
  readonly VITE_AURKA_CHAIN_ID?: string;
  readonly VITE_AURKA_API_URL?: string;
};

const environment = import.meta.env as ClientEnvironment;

function configuredUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const appMode: "demo" | "fork" =
  environment.VITE_AURKA_MODE === "fork" ? "fork" : "demo";

const configuredChainId = Number(environment.VITE_AURKA_CHAIN_ID ?? "31337");

/** The browser app has one deployment; the API may still run as a separate process. */
export const apiBaseUrl =
  configuredUrl(environment.VITE_AURKA_API_URL) ?? "/api";

export const supportedChainId =
  Number.isSafeInteger(configuredChainId) && configuredChainId > 0
    ? configuredChainId
    : 31337;

export const environmentLabel = appMode === "fork" ? "Fork demo" : "Local demo";
