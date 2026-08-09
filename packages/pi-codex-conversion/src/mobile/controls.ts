import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexMobileController } from "./controller.ts";

export const MOBILE_ACTIONS = ["mobile start", "mobile stop", "mobile pair", "mobile status"] as const;

export interface CodexMobileControls {
	handle(arg: string, ctx: ExtensionContext): Promise<boolean>;
}

export function createCodexMobileControls(mobile: CodexMobileController): CodexMobileControls {
	const startOptions = (ctx: ExtensionContext) => {
		if (!ctx.model) throw new Error("No active Pi model");
		return { cwd: ctx.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel };
	};
	return {
		async handle(arg: string, ctx: ExtensionContext): Promise<boolean> {
			const action = MOBILE_ACTIONS.find((candidate) => candidate === arg);
			if (!action) return false;
			try {
				if (action === "mobile start") {
					const url = await mobile.start(startOptions(ctx));
					ctx.ui.notify(`Codex Mobile is running at ${url}. Run /codex mobile pair to connect.`, "info");
				} else if (action === "mobile stop") {
					await mobile.stop();
					ctx.ui.notify("Codex Mobile stopped", "info");
				} else if (action === "mobile pair") {
					ctx.ui.notify(await mobile.pair(mobile.status() ? undefined : startOptions(ctx)) || "Codex Mobile pairing started", "info");
				} else {
					const url = mobile.status();
					ctx.ui.notify(url ? `Codex Mobile is running at ${url}` : "Codex Mobile is stopped", "info");
				}
			} catch (error) {
				ctx.ui.notify(`Could not ${action.slice("mobile ".length)} Codex Mobile: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return true;
		},
	};
}
