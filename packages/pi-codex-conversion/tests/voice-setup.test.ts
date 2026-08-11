import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CODEX_CONVERSION_CONFIG,
	type CodexConversionConfig,
} from "../src/adapter/activation/config.ts";
import { missingVoiceAudioSettings } from "../src/voice/setup.ts";

function configWithVoice(
	voice: Partial<CodexConversionConfig["voice"]>,
): CodexConversionConfig {
	return {
		...structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG),
		voice: {
			...DEFAULT_CODEX_CONVERSION_CONFIG.voice,
			...voice,
		},
	};
}

test("realtime voice uses the system default output when no speaker is pinned", () => {
	const config = configWithVoice({ inputDevice: "microphone" });

	assert.deepEqual(missingVoiceAudioSettings(config), []);
});

test("voice setup still requires an input device", () => {
	const config = configWithVoice({ outputDevice: "speaker" });

	assert.deepEqual(missingVoiceAudioSettings(config), [
		"voice.inputDevice",
	]);
});
