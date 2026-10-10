import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID, registerCliproxy } from "../src/cliproxy/provider.ts";

// CLIProxyAPI provider (moved from ~/Projects/pi-cliproxy; catalog lookups indexed for fast startup).
export default async function (pi: ExtensionAPI) {
  await registerCliproxy((config) => pi.registerProvider(PROVIDER_ID, config));
}
