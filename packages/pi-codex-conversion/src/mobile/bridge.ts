import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BridgeSession } from "./sessions.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export interface BridgeRegistry {
	get(threadId: string, cwd: string): Promise<BridgeSession>;
	resume(threadId: string, sessionId: string): Promise<void>;
}

export function createMobileBridgeServer(registry: BridgeRegistry, defaultCwd?: string): Server {
	const running = new Set<string>();
	return createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/responses") return sendJson(response, 404, "Not found");
		try {
			const bridgeRequest = parseCodexBridgeRequest(await readJson(request), defaultCwd);
			if (running.has(bridgeRequest.threadId)) return sendJson(response, 409, "This Pi session is already running");
			running.add(bridgeRequest.threadId);
			try {
				await runRequest(bridgeRequest, registry, response);
			} finally {
				running.delete(bridgeRequest.threadId);
			}
		} catch (error) {
			if (!response.headersSent) sendJson(response, error instanceof RequestError ? error.status : 500, message(error));
			else response.end();
		}
	});
}

async function runRequest(request: BridgeRequest, registry: BridgeRegistry, response: ServerResponse): Promise<void> {
	const stream = new ResponsesStream(response);
	if (request.resumeSessionId) {
		await registry.resume(request.threadId, request.resumeSessionId);
		stream.start();
		stream.delta("Pi session resumed. Send your next message to continue.");
		stream.complete();
		return;
	}
	const session = await registry.get(request.threadId, request.cwd);
	if (request.thinkingLevel) session.setThinkingLevel(request.thinkingLevel);
	let settled = false;
	const activity = new ActivityPresenter();
	stream.start();
	const unsubscribe = session.subscribe((event) => {
		if (isAssistantMessageStart(event)) stream.startMessage();
		else if (isAssistantMessageEnd(event)) stream.finishMessage();
		else if (isTextDelta(event)) stream.delta(event.assistantMessageEvent.delta);
		else {
			for (const text of activity.present(event)) stream.activity(text.endsWith("\n") ? text : `${text}\n`);
		}
	});
	response.on("close", () => { if (!settled) session.abort(); });
	try {
		await session.prompt(request.prompt);
		settled = true;
		stream.complete();
	} catch (error) {
		settled = true;
		stream.fail(error);
	} finally {
		unsubscribe();
	}
}

interface BridgeRequest {
	threadId: string;
	cwd: string;
	prompt: string;
	resumeSessionId?: string;
	thinkingLevel?: "low" | "medium" | "high";
}

export function parseCodexBridgeRequest(value: unknown, defaultCwd?: string): BridgeRequest {
	if (!record(value)) throw new RequestError(400, "Request body must be an object");
	const metadata = record(value["client_metadata"]) ? value["client_metadata"] : {};
	const threadId = text(metadata["thread_id"]) ?? text(value["prompt_cache_key"]);
	if (!threadId) throw new RequestError(400, "Codex thread_id is required");
	const messages = Array.isArray(value["input"]) ? value["input"].filter(record).filter((item) => item["type"] === "message") : [];
	const cwd = messages.map(messageText).map(environmentCwd).find(Boolean) ?? defaultCwd;
	if (!cwd) throw new RequestError(400, "Codex working directory is required on the first turn");
	const prompt = messages.toReversed().filter((item) => item["role"] === "user").map(messageText).find((item) => item.trim() && !item.includes("<environment_context>"));
	if (!prompt) throw new RequestError(400, "Codex user prompt is required");
	const effort = record(value["reasoning"]) ? value["reasoning"]["effort"] : undefined;
	const resumeSessionId = prompt.trim().match(/^\/resume\s+([0-9a-f-]{36})$/i)?.[1];
	return {
		threadId,
		cwd,
		prompt,
		...(resumeSessionId ? { resumeSessionId } : {}),
		...(effort === "low" || effort === "medium" || effort === "high" ? { thinkingLevel: effort } : {}),
	};
}

function messageText(item: Record<string, unknown>): string {
	if (typeof item["content"] === "string") return item["content"];
	return Array.isArray(item["content"])
		? item["content"].filter(record).filter((part) => part["type"] === "input_text").map((part) => text(part["text"]) ?? "").join("\n")
		: "";
}

function environmentCwd(value: string): string | undefined {
	return value.match(/<environment_context>[\s\S]*?<cwd>([\s\S]*?)<\/cwd>[\s\S]*?<\/environment_context>/)?.[1]?.trim();
}

class ResponsesStream {
	private readonly responseId = `resp_${randomUUID()}`;
	private readonly reasoningId = `rs_${randomUUID()}`;
	private readonly response: ServerResponse;
	private activityOutput = "";
	private currentMessage: { id: string; outputIndex: number; text: string } | undefined;
	private readonly messages: unknown[] = [];
	private nextOutputIndex = 1;

	constructor(response: ServerResponse) { this.response = response; }

	start(): void {
		this.response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream", "x-content-type-options": "nosniff" });
		this.send({ type: "response.created", response: { id: this.responseId, status: "in_progress", output: [] } });
		this.send({ type: "response.output_item.added", output_index: 0, item: this.reasoning("in_progress", "") });
		this.send({ type: "response.reasoning_summary_part.added", output_index: 0, summary_index: 0, item_id: this.reasoningId, part: this.summary("") });
	}

	activity(value: string): void {
		if (!value) return;
		this.activityOutput += value;
		this.send({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: this.reasoningId, delta: value });
	}

	startMessage(): void {
		this.finishMessage();
		const message = { id: `msg_${randomUUID()}`, outputIndex: this.nextOutputIndex++, text: "" };
		this.currentMessage = message;
		this.send({ type: "response.output_item.added", output_index: message.outputIndex, item: this.item(message.id, "in_progress", []) });
		this.send({ type: "response.content_part.added", output_index: message.outputIndex, content_index: 0, item_id: message.id, part: this.part("") });
	}

	delta(value: string): void {
		if (!value) return;
		if (!this.currentMessage) this.startMessage();
		const message = this.currentMessage!;
		message.text += value;
		this.send({ type: "response.output_text.delta", output_index: message.outputIndex, content_index: 0, item_id: message.id, delta: value, logprobs: [] });
	}

	finishMessage(): void {
		const message = this.currentMessage;
		if (!message) return;
		const part = this.part(message.text);
		const item = this.item(message.id, "completed", [part]);
		this.send({ type: "response.output_text.done", output_index: message.outputIndex, content_index: 0, item_id: message.id, text: message.text, logprobs: [] });
		this.send({ type: "response.content_part.done", output_index: message.outputIndex, content_index: 0, item_id: message.id, part });
		this.send({ type: "response.output_item.done", output_index: message.outputIndex, item });
		this.messages.push(item);
		this.currentMessage = undefined;
	}

	complete(): void {
		this.finishMessage();
		const reasoning = this.reasoning("completed", this.activityOutput);
		this.send({ type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0, item_id: this.reasoningId, text: this.activityOutput });
		this.send({ type: "response.reasoning_summary_part.done", output_index: 0, summary_index: 0, item_id: this.reasoningId, part: this.summary(this.activityOutput) });
		this.send({ type: "response.output_item.done", output_index: 0, item: reasoning });
		this.send({ type: "response.completed", response: { id: this.responseId, status: "completed", output: [reasoning, ...this.messages], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } });
		this.response.end();
	}

	fail(error: unknown): void {
		this.send({ type: "response.failed", response: { id: this.responseId, status: "failed", error: { code: "pi_bridge_error", message: message(error) } } });
		this.response.end();
	}

	private part(value: string) { return { type: "output_text", text: value, annotations: [] }; }
	private summary(value: string) { return { type: "summary_text", text: value }; }
	private reasoning(status: string, value: string) { return { type: "reasoning", id: this.reasoningId, status, summary: value ? [this.summary(value)] : [] }; }
	private item(id: string, status: string, content: unknown[]) { return { type: "message", id, role: "assistant", status, content }; }
	private send(value: unknown): void { this.response.write(`data: ${JSON.stringify(value)}\n\n`); }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if ((size += buffer.byteLength) > MAX_REQUEST_BYTES) throw new RequestError(413, "Request body is too large");
		chunks.push(buffer);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
	catch { throw new RequestError(400, "Request body must be JSON"); }
}

function isTextDelta(value: unknown): value is { assistantMessageEvent: { type: "text_delta"; delta: string } } {
	if (!record(value) || value["type"] !== "message_update" || !record(value["assistantMessageEvent"])) return false;
	return value["assistantMessageEvent"]["type"] === "text_delta" && typeof value["assistantMessageEvent"]["delta"] === "string";
}

function isAssistantMessageStart(value: unknown): boolean {
	return record(value) && value["type"] === "message_start" && record(value["message"]) && value["message"]["role"] === "assistant";
}

function isAssistantMessageEnd(value: unknown): boolean {
	return record(value) && value["type"] === "message_end" && record(value["message"]) && value["message"]["role"] === "assistant";
}

class ActivityPresenter {
	private readonly traceStates = new Map<string, string>();
	private readonly tracedCalls = new Set<string>();

	present(value: unknown): string[] {
		if (!record(value)) return [];
		if (value["type"] === "mobile_presentation") return text(value["text"]) ? [text(value["text"])!] : [];
		if (value["type"] === "tool_execution_update") return this.traceUpdates(value);
		const name = text(value["toolName"]);
		if (!name) return [];
		const callId = text(value["toolCallId"]);
		if (value["type"] === "tool_execution_start") return name === "exec" ? [] : [toolStart(name, value["args"])];
		if (value["type"] !== "tool_execution_end") return [];
		if (name === "exec" && callId && this.tracedCalls.has(callId)) return [];
		return [toolEnd(name, value["result"], Boolean(value["isError"]))];
	}

	private traceUpdates(event: Record<string, unknown>): string[] {
		const callId = text(event["toolCallId"]);
		const partial = record(event["partialResult"]) ? event["partialResult"] : {};
		const details = record(partial["details"]) ? partial["details"] : {};
		if (!callId || !Array.isArray(details["traces"])) return [];
		const output: string[] = [];
		for (const trace of details["traces"].filter(record)) {
			const id = text(trace["id"]);
			const name = text(trace["name"]);
			const status = text(trace["status"]);
			if (!id || !name || !status) continue;
			this.tracedCalls.add(callId);
			const key = `${callId}:${id}`;
			const previous = this.traceStates.get(key);
			if (!previous) output.push(traceStart(name, trace["input"]));
			if (status !== previous && status !== "running") output.push(traceEnd(name, trace));
			this.traceStates.set(key, status);
		}
		return output;
	}
}

function toolStart(name: string, value: unknown): string {
	const args = record(value) ? value : {};
	const command = text(args["command"]);
	if (name === "bash" && command) return `\n\n**Pi tool: bash**\n\n${code(command, "sh", 2_000)}\n`;
	const target = ["path", "url", "query", "pattern"].map((key) => text(args[key])).find(Boolean);
	return `\n\n**Pi tool: ${name}**${target ? ` ${inline(target)}` : ""}\n`;
}

function toolEnd(name: string, value: unknown, failed: boolean): string {
	const result = record(value) ? value : {};
	const details = record(result["details"]) ? result["details"] : {};
	const patch = text(details["patch"]);
	const output = name === "read" ? undefined : patch ?? resultText(result);
	return `\n**Pi tool: ${name} ${failed ? "failed" : "completed"}**${output ? `\n\n${code(output, patch ? "diff" : "text", 4_000)}` : ""}\n`;
}

function traceStart(name: string, value: unknown): string {
	if (name === "exec_command" && record(value) && text(value["cmd"])) {
		return `\n\n**Command**\n\n${code(text(value["cmd"])!, "sh", 2_000)}\n`;
	}
	if (name === "apply_patch" && typeof value === "string") {
		const paths = patchPaths(value);
		return `\n\n**Editing${paths.length ? ` ${paths.map(inline).join(", ")}` : ""}**\n`;
	}
	return `\n\n**Pi tool: ${name}**\n`;
}

function traceEnd(name: string, trace: Record<string, unknown>): string {
	const result = record(trace["result"]) ? trace["result"] : {};
	const details = record(result["details"]) ? result["details"] : {};
	if (name === "exec_command") {
		const exitCode = typeof details["exit_code"] === "number" ? details["exit_code"] : undefined;
		const duration = typeof details["wall_time_seconds"] === "number" ? `${details["wall_time_seconds"].toFixed(2)}s` : undefined;
		const output = text(details["output"]);
		const status = exitCode === undefined || exitCode === 0 ? "completed" : `failed with exit ${exitCode}`;
		return `\n**Command ${status}${duration ? ` in ${duration}` : ""}**${output ? `\n\n${code(output, "text", 4_000)}` : ""}\n`;
	}
	if (name === "apply_patch" && typeof trace["input"] === "string") {
		const patch = trace["input"];
		return `\n**Edit completed**\n\n${code(patch, "diff", 4_000)}\n`;
	}
	return `\n**Pi tool: ${name} ${trace["status"] === "done" ? "completed" : "failed"}**\n`;
}

function patchPaths(value: string): string[] {
	return [...value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!);
}

function resultText(result: Record<string, unknown>): string | undefined {
	if (!Array.isArray(result["content"])) return undefined;
	const output = result["content"]
		.filter(record)
		.filter((part) => part["type"] === "text")
		.map((part) => text(part["text"]) ?? "")
		.filter(Boolean)
		.join("\n");
	return output || undefined;
}

function inline(value: string): string { return `\`${value.replaceAll("`", "'")}\``; }
function code(value: string, language: string, limit: number): string {
	const truncated = value.length > limit ? `${value.slice(0, limit)}\n… output truncated` : value;
	return `\`\`\`${language}\n${truncated.replaceAll("```", "`` `")}\n\`\`\``;
}

function sendJson(response: ServerResponse, status: number, error: string): void {
	response.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff" });
	response.end(JSON.stringify({ error: { message: error } }));
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

class RequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
