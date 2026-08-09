import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentSession, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export interface BridgeSession {
	prompt(message: string): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	setThinkingLevel(level: "low" | "medium" | "high"): void;
	abort(): void;
	dispose(): void;
}

export class BridgeSessionRegistry {
	private readonly active = new Map<string, BridgeSession>();
	private readonly statePath: string;
	private readonly agentDir: string;
	private readonly initial: { model: Model<any>; thinkingLevel?: ThinkingLevel | undefined } | undefined;
	private saveChain = Promise.resolve();
	private stored?: Record<string, string>;

	constructor(statePath: string, agentDir: string, initial?: { model: Model<any>; thinkingLevel?: ThinkingLevel | undefined }) {
		this.statePath = statePath;
		this.agentDir = agentDir;
		this.initial = initial;
	}

	async get(threadId: string, cwd: string): Promise<BridgeSession> {
		const existing = this.active.get(threadId);
		if (existing) return existing;
		const session = await this.open(threadId, cwd);
		this.active.set(threadId, session);
		return session;
	}

	async resume(threadId: string, sessionId: string): Promise<void> {
		const sessionFile = await findSessionFile(sessionId, this.agentDir);
		if (!sessionFile) throw new Error(`Pi session ${sessionId} was not found`);
		const active = this.active.get(threadId);
		active?.dispose();
		this.active.delete(threadId);
		(await this.load())[threadId] = sessionFile;
		await this.save();
	}

	async close(): Promise<void> {
		for (const session of this.active.values()) session.dispose();
		this.active.clear();
	}

	private async open(threadId: string, cwd: string): Promise<BridgeSession> {
		const stored = (await this.load())[threadId];
		const sessionManager = stored
			? SessionManager.open(stored)
			: SessionManager.create(cwd, join(this.agentDir, "sessions", "codex-mobile"));
		const initial = !stored ? this.initial : undefined;
		const { session } = await createAgentSession({
			cwd: sessionManager.getCwd(),
			agentDir: this.agentDir,
			sessionManager,
			...(initial ? {
				model: initial.model,
				...(initial.thinkingLevel !== undefined ? { thinkingLevel: initial.thinkingLevel } : {}),
			} : {}),
		});
		if (!stored && session.sessionFile) {
			this.stored![threadId] = session.sessionFile;
			await this.save();
		}
		return MobileBridgeSession.create(session);
	}

	private async load(): Promise<Record<string, string>> {
		if (this.stored) return this.stored;
		try {
			const value = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
			this.stored = isStoredSessions(value) ? value : {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.stored = {};
		}
		return this.stored;
	}

	private async save(): Promise<void> {
		const write = async () => {
			await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
			const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
			await writeFile(temporaryPath, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
			await rename(temporaryPath, this.statePath);
		};
		this.saveChain = this.saveChain.then(write, write);
		await this.saveChain;
	}
}

class MobileBridgeSession implements BridgeSession {
	private readonly listeners = new Set<(event: unknown) => void>();
	private readonly queued: unknown[] = [];
	private readonly session: AgentSession;
	private readonly unsubscribe: () => void;

	private constructor(session: AgentSession) {
		this.session = session;
		this.unsubscribe = session.subscribe((event) => this.emit(event));
	}

	static async create(session: AgentSession): Promise<MobileBridgeSession> {
		const mobile = new MobileBridgeSession(session);
		await session.bindExtensions({
			mode: "print",
			uiContext: createMobileUI((text) => mobile.emit({ type: "mobile_presentation", text })),
			onError: (error) => mobile.emit({ type: "mobile_presentation", text: `[Pi extension error] ${error.error}` }),
		});
		return mobile;
	}

	prompt(message: string): Promise<void> { return this.session.prompt(message); }
	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		for (const event of this.queued.splice(0)) listener(event);
		return () => this.listeners.delete(listener);
	}
	setThinkingLevel(level: "low" | "medium" | "high"): void { this.session.setThinkingLevel(level); }
	abort(): void { void this.session.abort(); }
	dispose(): void {
		this.unsubscribe();
		this.session.dispose();
	}

	private emit(event: unknown): void {
		if (this.listeners.size) {
			for (const listener of this.listeners) listener(event);
			return;
		}
		this.queued.push(event);
		if (this.queued.length > 20) this.queued.shift();
	}
}

export function createMobileUI(present: (text: string) => void): ExtensionUIContext {
	const blocked = (kind: string, title: string, detail?: string) => {
		present(`[Pi ${kind} blocked] ${title}${detail ? `: ${detail}` : ""}. Open this session in Pi to respond.`);
	};
	return {
		select: async (title, options) => { blocked("selection", title, options.join(", ")); return undefined; },
		confirm: async (title, message) => { blocked("confirmation", title, message); return false; },
		input: async (title, placeholder) => { blocked("input", title, placeholder); return undefined; },
		notify: (message, type = "info") => present(`[Pi ${type}] ${message}`),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async (title, prefill) => { blocked("editor", title, prefill); return undefined; },
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): never { throw new Error("Theme UI is unavailable in Codex Mobile"); },
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme UI is unavailable in Codex Mobile" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

async function findSessionFile(sessionId: string, agentDir: string): Promise<string | undefined> {
	const sessionsDir = join(agentDir, "sessions");
	let entries;
	try {
		entries = await readdir(sessionsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const directories = entries
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => join(sessionsDir, entry.name));
	const sessions = (await Promise.all(directories.map((directory) => SessionManager.listAll(directory)))).flat();
	return sessions.find((session) => session.id === sessionId)?.path;
}

function isStoredSessions(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every((sessionFile) => typeof sessionFile === "string");
}
