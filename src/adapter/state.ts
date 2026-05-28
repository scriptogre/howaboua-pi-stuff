import type { PromptSkill } from "../prompt/build-system-prompt.ts";
import type { CodexConversionConfig } from "./config.ts";
import type { ResponsesInputItem } from "./serializer.ts";

export interface PendingPiCompactionNativeWindow {
	window: ResponsesInputItem[];
	provider: string;
	api: string;
	baseUrl: string;
	sessionId: string;
	sourceCompactionEntryId?: string;
}

export interface AdapterState {
	enabled: boolean;
	cwd: string;
	adapterOwnedToolNames?: string[];
	previousToolNames?: string[];
	promptSkills: PromptSkill[];
	config: CodexConversionConfig;
	pendingPiCompactionNativeWindow?: PendingPiCompactionNativeWindow;
	codexContextBudgetRawWindows?: Record<string, number>;
	codexContextBudgetAdjustedWindows?: Record<string, number>;
	codexContextBudgetReserveTokens?: number;
}
