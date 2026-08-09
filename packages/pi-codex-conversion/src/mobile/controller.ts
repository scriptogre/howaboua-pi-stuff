import { execFile } from "node:child_process";
import { lstat, mkdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { BridgeSessionRegistry } from "./sessions.ts";
import { createMobileBridgeServer } from "./bridge.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 61_340;

export interface CodexMobileStartOptions {
	cwd: string;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel | undefined;
}

export type CodexRemoteControlRunner = (
	action: "start" | "stop" | "pair",
	options: { codexHome: string },
) => Promise<string>;

interface ActiveBridge {
	server: Server;
	registry: BridgeSessionRegistry;
	url: string;
}

export class CodexMobileController {
	private readonly statePath: string;
	private readonly agentDir: string;
	private readonly codexHome: string;
	private readonly sourceCodexHome: string;
	private readonly port: number;
	private readonly runRemoteControl: CodexRemoteControlRunner;
	private active: ActiveBridge | undefined;
	private operation = Promise.resolve();

	constructor(agentDir: string, options: {
		statePath?: string | undefined;
		port?: number | undefined;
		codexHome?: string | undefined;
		sourceCodexHome?: string | undefined;
		runRemoteControl?: CodexRemoteControlRunner | undefined;
	} = {}) {
		this.agentDir = agentDir;
		this.codexHome = options.codexHome ?? join(agentDir, "codex-mobile", "codex-home");
		this.sourceCodexHome = options.sourceCodexHome ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
		this.statePath = options.statePath ?? process.env["PI_CODEX_BRIDGE_STATE"] ?? join(agentDir, "codex-mobile-bridge.json");
		this.port = options.port ?? parsePort(process.env["PI_CODEX_BRIDGE_PORT"]);
		this.runRemoteControl = options.runRemoteControl ?? runCodexRemoteControl;
	}

	status(): string | undefined { return this.active?.url; }

	start(options: CodexMobileStartOptions): Promise<string> {
		return this.enqueue(async () => {
			if (this.active) return this.active.url;
			const registry = new BridgeSessionRegistry(this.statePath, this.agentDir, {
				model: options.model,
				...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			});
			const server = createMobileBridgeServer(registry, options.cwd);
			try {
				await listen(server, this.port);
				const address = server.address() as AddressInfo;
				const url = `http://${DEFAULT_HOST}:${address.port}/v1`;
				await prepareCodexHome(this.codexHome, this.sourceCodexHome, url, options.model.id);
				await this.runRemoteControl("start", { codexHome: this.codexHome });
				this.active = { server, registry, url };
				return url;
			} catch (error) {
				await closeBridge({ server, registry });
				throw error;
			}
		});
	}

	async pair(options?: CodexMobileStartOptions): Promise<string> {
		if (!this.active) {
			if (!options) throw new Error("No active Pi model is available to start Codex Mobile");
			await this.start(options);
		}
		return this.enqueue(async () => {
			return this.runRemoteControl("pair", { codexHome: this.codexHome });
		});
	}

	stop(): Promise<void> {
		return this.enqueue(async () => {
			const active = this.active;
			this.active = undefined;
			if (!active) return;
			const results = await Promise.allSettled([this.runRemoteControl("stop", { codexHome: this.codexHome }), closeBridge(active)]);
			const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Codex Mobile cleanup failed");
		});
	}

	private enqueue<T>(action: () => Promise<T>): Promise<T> {
		const result = this.operation.then(action, action);
		this.operation = result.then(() => undefined, () => undefined);
		return result;
	}
}

export async function runCodexRemoteControl(
	action: "start" | "stop" | "pair",
	options: { codexHome: string },
): Promise<string> {
	const args = buildCodexRemoteControlArgs(action);
	const command = process.env["PI_CODEX_MOBILE_CODEX"] ?? "codex";
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			env: { ...process.env, CODEX_HOME: options.codexHome },
			maxBuffer: 1024 * 1024,
		});
		return `${stdout}${stderr}`.trim();
	} catch (error) {
		const failure = error as Error & { stderr?: string | Buffer | undefined };
		const detail = failure.stderr?.toString().trim();
		throw new Error(formatRemoteControlError(detail || failure.message), { cause: error });
	}
}

function formatRemoteControlError(message: string): string {
	if (message.includes("managed standalone Codex install not found")) {
		return "Codex Mobile needs the official managed Codex install. Install it from https://chatgpt.com/codex/install.sh, then retry.";
	}
	return message;
}

export function buildCodexRemoteControlArgs(action: "start" | "stop" | "pair"): string[] {
	return ["remote-control", action];
}

export function buildCodexMobileConfig(bridgeUrl: string, modelId: string): string {
	return `model = ${JSON.stringify(modelId)}
model_provider = "pi_bridge"

[model_providers.pi_bridge]
name = "Pi Bridge"
base_url = ${JSON.stringify(bridgeUrl)}
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[model_providers.pi_bridge.auth]
command = ${JSON.stringify(process.execPath)}
args = ["-e", "process.stdout.write('pi-bridge-local')"]
`;
}

async function prepareCodexHome(codexHome: string, sourceCodexHome: string, bridgeUrl: string, modelId: string): Promise<void> {
	await mkdir(join(codexHome, "packages"), { recursive: true, mode: 0o700 });
	await Promise.all([
		ensureLink(join(sourceCodexHome, "auth.json"), join(codexHome, "auth.json")),
		ensureLink(join(sourceCodexHome, "packages", "standalone"), join(codexHome, "packages", "standalone")),
		writeFile(join(codexHome, "config.toml"), buildCodexMobileConfig(bridgeUrl, modelId), { mode: 0o600 }),
	]);
}

async function ensureLink(target: string, path: string): Promise<void> {
	try {
		if ((await lstat(path)).isSymbolicLink() && await readlink(path) === target) return;
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await symlink(target, path);
}

function parsePort(value: string | undefined): number {
	if (!value) return DEFAULT_PORT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PI_CODEX_BRIDGE_PORT must be a valid port");
	return parsed;
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, DEFAULT_HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function closeBridge(active: Pick<ActiveBridge, "server" | "registry">): Promise<void> {
	const listening = active.server.listening;
	const closing = listening
		? new Promise<void>((resolve, reject) => active.server.close((error) => error ? reject(error) : resolve()))
		: Promise.resolve();
	if (listening) active.server.closeAllConnections();
	await Promise.all([closing, active.registry.close()]);
}
