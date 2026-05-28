import type { Api, Model } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "./state.ts";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_API = "openai-codex-responses";
const CODEX_AUTO_COMPACT_NUMERATOR = 9;
const CODEX_AUTO_COMPACT_DENOMINATOR = 10;
const PI_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export function getCodexAutoCompactBudget(contextWindow: number): number {
	return Math.floor((contextWindow * CODEX_AUTO_COMPACT_NUMERATOR) / CODEX_AUTO_COMPACT_DENOMINATOR);
}

export function getPiContextWindowForCodexAutoCompact(contextWindow: number, reserveTokens = PI_DEFAULT_COMPACTION_RESERVE_TOKENS): number {
	return Math.min(contextWindow, getCodexAutoCompactBudget(contextWindow) + reserveTokens);
}

function readSettings(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function getReserveTokens(settings: Record<string, unknown> | undefined): number | undefined {
	const compaction = settings?.["compaction"];
	if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return undefined;
	const reserveTokens = (compaction as { reserveTokens?: unknown | undefined }).reserveTokens;
	return typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens >= 0 ? reserveTokens : undefined;
}

export function readPiCompactionReserveTokens(cwd: string): number {
	return (
		getReserveTokens(readSettings(join(cwd, ".pi", "settings.json"))) ??
		getReserveTokens(readSettings(join(getAgentDir(), "settings.json"))) ??
		PI_DEFAULT_COMPACTION_RESERVE_TOKENS
	);
}

export function shouldUseCodexContextBudgetModel(model: Model<Api> | undefined): model is Model<Api> {
	return model?.provider === OPENAI_CODEX_PROVIDER && model.api === OPENAI_CODEX_API;
}

function getModelKey(model: Model<Api>): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

function resolveRawContextWindow<TApi extends Api>(model: Model<TApi>, state: AdapterState | undefined): number {
	if (!state) return model.contextWindow;
	const key = getModelKey(model);
	const cachedRaw = state.codexContextBudgetRawWindows?.[key];
	if (cachedRaw === undefined) {
		state.codexContextBudgetRawWindows ??= {};
		state.codexContextBudgetRawWindows[key] = model.contextWindow;
		return model.contextWindow;
	}

	const cachedAdjusted = getPiContextWindowForCodexAutoCompact(cachedRaw, state.codexContextBudgetReserveTokens);
	const previousAdjusted = state.codexContextBudgetAdjustedWindows?.[key];
	if (model.contextWindow !== cachedRaw && model.contextWindow !== cachedAdjusted && model.contextWindow !== previousAdjusted) {
		state.codexContextBudgetRawWindows ??= {};
		state.codexContextBudgetRawWindows[key] = model.contextWindow;
		delete state.codexContextBudgetAdjustedWindows?.[key];
		return model.contextWindow;
	}
	return cachedRaw;
}

export function getCodexContextBudgetAdjustedModel<TApi extends Api>(model: Model<TApi>, state?: AdapterState): Model<TApi> {
	if (!shouldUseCodexContextBudgetModel(model)) return model;
	const rawContextWindow = resolveRawContextWindow(model, state);
	const contextWindow = getPiContextWindowForCodexAutoCompact(rawContextWindow, state?.codexContextBudgetReserveTokens);
	if (state) {
		state.codexContextBudgetAdjustedWindows ??= {};
		state.codexContextBudgetAdjustedWindows[getModelKey(model)] = contextWindow;
	}
	return contextWindow === model.contextWindow ? model : { ...model, contextWindow };
}

export function applyCodexContextBudgetToModel<TApi extends Api>(model: Model<TApi> | undefined, state: AdapterState): void {
	if (!model) return;
	state.codexContextBudgetReserveTokens ??= readPiCompactionReserveTokens(state.cwd);
	const adjustedModel = getCodexContextBudgetAdjustedModel(model, state);
	if (adjustedModel !== model) {
		model.contextWindow = adjustedModel.contextWindow;
	}
}
