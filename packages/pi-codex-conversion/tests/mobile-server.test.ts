import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createMobileBridgeServer } from "../src/mobile/bridge.ts";
import type { BridgeSession } from "../src/mobile/sessions.ts";

test("mobile bridge streams Pi text as an OpenAI Responses result", async () => {
	const listeners = new Set<(event: unknown) => void>();
	const prompts: string[] = [];
	const thinkingLevels: string[] = [];
	const session: BridgeSession = {
		prompt: async (message) => {
			prompts.push(message);
			for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant" } });
			for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I’ll check." } });
			for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant" } });
			const toolCallId = "call-1";
			for (const listener of listeners) listener({ type: "tool_execution_start", toolCallId, toolName: "exec", args: { code: "internal orchestration" } });
			for (const listener of listeners) listener({ type: "tool_execution_update", toolCallId, toolName: "exec", partialResult: { details: { traces: [
				{ id: "trace-1", name: "exec_command", input: { cmd: "git status --short" }, status: "done", result: { details: { output: "Working tree clean", exit_code: 0, wall_time_seconds: 0.01 } } },
				{ id: "trace-2", name: "apply_patch", input: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-old\n+new\n*** End Patch", status: "done", result: { details: { status: "success" } } },
			] } } });
			for (const listener of listeners) listener({ type: "tool_execution_end", toolCallId, toolName: "exec", isError: false, result: { content: [{ type: "text", text: "Script completed" }] } });
			for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant" } });
			for (const delta of ["Hello", " from Pi"]) {
				for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
			}
			for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant" } });
		},
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		setThinkingLevel: (level) => { thinkingLevels.push(level); },
		abort: () => {},
		dispose: () => {},
	};
	const server = createMobileBridgeServer({ get: async () => session, resume: async () => {} }, "/work/project");
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address() as AddressInfo;
		const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_metadata: { thread_id: "thread-1" },
				reasoning: { effort: "high" },
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Do work" }] }],
			}),
		});
		const body = await response.text();
		assert.equal(response.status, 200);
		assert.deepEqual(prompts, ["Do work"]);
		assert.deepEqual(thinkingLevels, ["high"]);
		assert.match(body, /response\.output_text\.delta/);
		assert.match(body, /response\.reasoning_summary_text\.delta/);
		assert.match(body, /\*\*Command\*\*/);
		assert.match(body, /git status --short/);
		assert.match(body, /Command completed/);
		assert.match(body, /Working tree clean/);
		assert.match(body, /Editing.*sample\.txt/);
		assert.match(body, /Edit completed/);
		assert.match(body, /-old/);
		assert.doesNotMatch(body, /internal orchestration|Script completed/);
		assert.match(body, /Hello from Pi/);
		assert.match(body, /I’ll check\./);
		assert.match(body, /Hello from Pi/);
		assert.equal((body.match(/response\.output_item\.done/g) ?? []).length, 3);
		assert.match(body, /response\.completed/);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("mobile bridge binds a Codex thread to an existing Pi session", async () => {
	const resumed: string[][] = [];
	const server = createMobileBridgeServer(
		{
			get: async () => { throw new Error("resume must not open a new session"); },
			resume: async (...args) => { resumed.push(args); },
		},
		"/home/chris",
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address() as AddressInfo;
		const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_metadata: { thread_id: "mobile-thread" },
				input: [{ type: "message", role: "user", content: "/resume 019fe258-6b88-782c-b4ff-05e8f1d20390" }],
			}),
		});
		const body = await response.text();
		assert.equal(response.status, 200);
		assert.deepEqual(resumed, [["mobile-thread", "019fe258-6b88-782c-b4ff-05e8f1d20390"]]);
		assert.match(body, /Pi session resumed/);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("mobile bridge aborts Pi when Codex disconnects", async () => {
	let rejectPrompt: ((error: Error) => void) | undefined;
	let markAborted!: () => void;
	const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
	const session: BridgeSession = {
		prompt: () => new Promise((_resolve, reject) => { rejectPrompt = reject; }),
		subscribe: () => () => {},
		setThinkingLevel: () => {},
		abort: () => { markAborted(); rejectPrompt?.(new Error("aborted")); },
		dispose: () => {},
	};
	const server = createMobileBridgeServer({ get: async () => session, resume: async () => {} }, "/work");
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address() as AddressInfo;
		const controller = new AbortController();
		const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt_cache_key: "thread", input: [{ type: "message", role: "user", content: "Work" }] }),
			signal: controller.signal,
		});
		controller.abort();
		await assert.rejects(response.text(), /abort/i);
		await aborted;
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
