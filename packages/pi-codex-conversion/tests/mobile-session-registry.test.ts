import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BridgeSessionRegistry, createMobileUI } from "../src/mobile/sessions.ts";

test("mobile UI presents notifications and denies unavailable dialogs", async () => {
	const presented: string[] = [];
	const ui = createMobileUI((text) => presented.push(text));
	ui.notify("Build finished", "info");
	assert.equal(await ui.confirm("Deploy", "Run production deploy"), false);
	assert.deepEqual(presented, [
		"[Pi info] Build finished",
		"[Pi confirmation blocked] Deploy: Run production deploy. Open this session in Pi to respond.",
	]);
});

test("resumed Pi sessions remain bound to their Codex thread", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-codex-mobile-state-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = root;
	const sessionId = "019fe258-6b88-782c-b4ff-05e8f1d20390";
	const sessionDir = join(root, "sessions", "project");
	const statePath = join(root, "codex-mobile-bridge.json");
	try {
		const sessionManager = SessionManager.create("/work", sessionDir, { id: sessionId });
		sessionManager.appendSessionInfo("Mobile test");
		sessionManager.appendMessage({
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile);
		assert.equal((await SessionManager.listAll(sessionDir))[0]?.id, sessionId);
		await new BridgeSessionRegistry(statePath, root).resume("mobile-thread", sessionId);
		assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { "mobile-thread": sessionFile });
	} finally {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
