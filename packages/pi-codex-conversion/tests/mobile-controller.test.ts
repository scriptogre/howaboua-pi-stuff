import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { buildCodexMobileConfig, buildCodexRemoteControlArgs, CodexMobileController } from "../src/mobile/controller.ts";

const model = { id: "gpt-5.6-sol", provider: "openai-codex" } as Model<any>;

test("Codex Mobile routes the active Pi model through the loopback provider", () => {
	assert.deepEqual(buildCodexRemoteControlArgs("start"), ["remote-control", "start"]);
	const config = buildCodexMobileConfig("http://127.0.0.1:61340/v1", model.id);
	assert.match(config, /model = "gpt-5\.6-sol"/);
	assert.match(config, /model_provider = "pi_bridge"/);
	assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:61340\/v1"/);
});

test("CodexMobileController pairing starts the bridge and daemon when needed", async () => {
	const temporaryDir = await mkdtemp(join(tmpdir(), "pi-codex-mobile-"));
	const sourceCodexHome = join(temporaryDir, "source-codex-home");
	const codexHome = join(temporaryDir, "mobile-codex-home");
	const actions: Array<{ action: string; codexHome: string }> = [];
	const controller = new CodexMobileController(temporaryDir, {
		codexHome,
		sourceCodexHome,
		statePath: join(temporaryDir, "state.json"),
		port: 0,
		runRemoteControl: async (action, options) => {
			actions.push({ action, ...options });
			return action === "pair" ? "Pair code: TEST" : "";
		},
	});
	try {
		assert.equal(await controller.pair({ cwd: temporaryDir, model }), "Pair code: TEST");
		const url = controller.status();
		assert.ok(url);
		assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
		await controller.stop();
		assert.deepEqual(actions.map(({ action }) => action), ["start", "pair", "stop"]);
		assert.ok(actions.every((action) => action.codexHome === codexHome));
		assert.equal(await readlink(join(codexHome, "auth.json")), join(sourceCodexHome, "auth.json"));
		assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), new RegExp(`base_url = ${JSON.stringify(url)}`));
		assert.equal(controller.status(), undefined);
	} finally {
		await controller.stop();
		await rm(temporaryDir, { recursive: true, force: true });
	}
});

test("CodexMobileController closes the bridge when Codex fails to start", async () => {
	const temporaryDir = await mkdtemp(join(tmpdir(), "pi-codex-mobile-"));
	const controller = new CodexMobileController(temporaryDir, {
		port: 0,
		runRemoteControl: async () => { throw new Error("Codex failed"); },
	});
	try {
		await assert.rejects(controller.start({ cwd: temporaryDir, model }), /Codex failed/);
		assert.equal(controller.status(), undefined);
	} finally {
		await rm(temporaryDir, { recursive: true, force: true });
	}
});
