/**
 * dsh-bao — a TRAE-宝-style personal assistant bundle for DeepSeek Harness.
 *
 * One bundle, four capabilities:
 *
 *  1. Daily digest. At a configured local time the Host collects a compact
 *     summary of every durable Schedule task (the system's own schedule
 *     service), plus the sessions that changed recently, and raises one
 *     desktop notification through the delivery channels in `./delivery.js`.
 *  2. `bao_status` tool. The model asks how the user's work is going and
 *     receives the same compact overview as text.
 *  3. `bao_notify` tool. The model raises a desktop notification with its own
 *     title and body — the assistant's proactive channel.
 *  4. A Web panel. The sidebar gains an assistant entry that opens a status
 *     page: next reminders, last digest, quick facts. The panel reads from a
 *     small loopback-fenced JSON route registered by this Host half.
 *
 * v0.2.4 adds:
 *  - Onboarding: first-time users get a sample memory and a welcome toast.
 *  - Auto-extract: the assistant can propose candidate memories from a
 *    conversation; users confirm or ignore them through the panel or tools.
 *
 * Everything the model could otherwise only reach through interactive tools
 * (`schedule_create`, `notify_user`, …) stays untouched: this bundle only
 * *reads* durable state and delivers notifications.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { deliver } from "./delivery.js";
import { openMemory, NOTE_CATEGORIES } from "./memory.js";

/** Defaults for every knob the row's `config` may override. */
const DEFAULTS = {
	/** Master switch: false keeps the tools, route, and digest off. */
	enabled: true,
	/** Master switch for the daily digest notification. */
	digestEnabled: true,
	/** Local time the digest fires at, `HH:mm` in the process time zone. */
	digestTime: "09:00",
	/** Register the `bao_notify` tool. */
	notifyTool: true,
	/** Register the `bao_status` tool. */
	statusTool: true,
	/** Register memory management tools. */
	memoryTools: true,
	/** Propose candidate memories automatically after relevant conversations. */
	autoExtractMemory: true,
	/** Run the first-time onboarding flow. */
	onboardingEnabled: true,
	/** How many recently-updated sessions the overview mentions. */
	sessionWindowCount: 5,
	/** How far back "recent" reaches, in milliseconds. */
	sessionWindowMs: 26 * 60 * 60 * 1000,
	/** Maximum characters of one overview line. */
	maxLineLength: 90,
	/** Maximum pending candidate memories kept before eviction. */
	pendingMemoryMax: 20,
	/** Play the system notification sound. */
	sound: true,
	/** Start Menu identity used for the Windows toast. */
	appUserModelId: "com.deepseek.dsh",
	/** Route prefix registered on the Host web server. */
	routePath: "/bao/api",
	/** Long-term memory: inject a recall section into every agent's context. */
	memoryInject: true,
	/** Maximum notes quoted in one injected recall section. */
	memoryInjectLimit: 30,
	/** Maximum characters of one note in the injected section. */
	memoryNoteMaxChars: 200
};

/**
 * Merge the row's config over the defaults, keeping only values of the
 * declared type so a malformed profile patch cannot break the plugin.
 * @param {object} [config] - the row's raw config.
 * @returns {object} the resolved options.
 */
function resolveOptions(config) {
	const raw = config !== undefined && config !== null && typeof config === "object" ? config : {};
	const options = { ...DEFAULTS };
	for (const [key, value] of Object.entries(raw)) {
		if (!Object.hasOwn(DEFAULTS, key)) continue;
		const fallback = DEFAULTS[key];
		if (typeof fallback === "boolean" && typeof value === "boolean") options[key] = value;
		else if (typeof fallback === "number" && typeof value === "number" && Number.isFinite(value)) options[key] = value;
		else if (typeof fallback === "string" && typeof value === "string") options[key] = value;
	}
	return options;
}

/**
 * Build a diagnostic sink that never breaks a session.
 * @param {object} ctx - the plugin context.
 * @returns {(message: string) => void} the sink.
 */
function createLogger(ctx) {
	return (message) => {
		try {
			ctx.logger?.("dsh-bao")?.info?.(message);
		} catch {
			// Diagnostics are best effort.
		}
	};
}

/**
 * Collapse a text to one line and cut it to the configured length.
 * @param {string} text - the raw text.
 * @param {number} maxLength - the maximum length.
 * @returns {string} the shortened text.
 */
function truncate(text, maxLength) {
	const collapsed = String(text).replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * Resolve the plugin state file path.
 * @param {object} ctx - the plugin context.
 * @returns {string} the absolute file path.
 */
function statePath(ctx) {
	const home = typeof ctx.dshHomePath === "function" ? ctx.dshHomePath() : process.env.DSH_HOME ?? process.cwd();
	return `${home}/bao/state.json`;
}

/**
 * Load the plugin state object.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<object>} the state.
 */
async function loadState(ctx) {
	try {
		const text = await readFile(statePath(ctx), "utf8");
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") return parsed;
	} catch {
		// Missing or corrupt state starts fresh.
	}
	return { onboarded: false };
}

/**
 * Save the plugin state object.
 * @param {object} ctx - the plugin context.
 * @param {object} state - the state to persist.
 * @returns {Promise<void>}
 */
async function saveState(ctx, state) {
	const path = statePath(ctx);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Describe a schedule rule in one human phrase (Chinese UI strings live in
 * the locale files; the Host builds the structured facts and both surfaces
 * share them).
 * @param {object} record - a decoded Schedule record.
 * @returns {string} the rule phrase.
 */
function describeRule(record) {
	switch (record.kind) {
		case "after":
			return `每 ${Math.round(record.afterSeconds / 60)} 分钟`;
		case "every":
			return `每 ${Math.round(record.everySeconds / 60)} 分钟`;
		case "daily":
			return `每天 ${record.time.slice(0, 5)}`;
		case "weekly":
			return `每周 ${record.weekdays.join("/")} ${record.time.slice(0, 5)}`;
		case "cron":
			return `cron ${record.expression}`;
		default:
			return "一次性";
	}
}

/**
 * Milliseconds until the next wall-clock fire of `HH:mm` in the process zone.
 * @param {string} hhmm - the configured local time.
 * @param {number} now - the current epoch milliseconds.
 * @returns {number} the delay in milliseconds, greater than zero.
 */
function nextDailyFire(hhmm, now) {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
	const minutes = match === null ? 9 * 60 : Number(match[1]) * 60 + Number(match[2]);
	const current = new Date(now);
	const base = new Date(current);
	base.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
	return base.getTime() > now ? base.getTime() - now : base.getTime() + 24 * 60 * 60 * 1000 - now;
}

/**
 * Map the wire `kind` of one schedule record to its timing selector object,
 * the shape `schedule_create` documents and the route echoes.
 * @param {object} record - a decoded Schedule record.
 * @returns {object} the selector object.
 */
function selectorOf(record) {
	switch (record.kind) {
		case "at":
			return { at: record.scheduledAt };
		case "after":
			return { after_seconds: record.afterSeconds };
		case "every":
			return { every_seconds: record.everySeconds };
		case "daily":
			return { daily: { time: record.time, time_zone: record.timeZone } };
		case "weekly":
			return { weekly: { time: record.time, weekdays: record.weekdays, time_zone: record.timeZone } };
		case "cron":
			return { cron: { expression: record.expression, time_zone: record.timeZone } };
		default:
			return {};
	}
}

/**
 * Whether a WHATWG URL hostname names the loopback authority.
 * @param {string} hostname - URL hostname form (IPv6 keeps brackets).
 * @returns {boolean} true for localhost, [::1], and 127/8.
 */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Canonical `hostname` or `hostname:port` of one trustedHosts entry.
 * @param {string} entry - the raw entry.
 * @param {URL} entryUrl - the entry parsed under the listener scheme.
 * @returns {string} the canonical authority form.
 */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/**
 * Whether the request authority matches a `trustedHosts` entry: with an
 * explicit port the exact authority must match, without one any port does.
 * @param {URL} hostUrl - the request's parsed Host authority.
 * @param {readonly string[]} trustedHosts - configured trusted hosts.
 * @param {string} protocol - the listener scheme.
 * @returns {boolean} true when an entry matches.
 */
function isTrustedAuthority(hostUrl, trustedHosts, protocol) {
	return trustedHosts.some((entry) => {
		let entryUrl;
		try {
			entryUrl = new URL(`${protocol}//${entry}`);
		} catch {
			return false;
		}
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host;
	});
}

/**
 * Compare Host under the Origin's HTTP(S) scheme so default ports normalize.
 * @param {string} origin - verbatim Origin header value.
 * @param {string} host - verbatim Host header value.
 * @returns {boolean} true only for this listener's own authority.
 */
function isSameAuthorityOrigin(origin, host) {
	let originUrl;
	try {
		originUrl = new URL(origin);
	} catch {
		return false;
	}
	const scheme = originUrl.protocol === "https:" ? "https:" : originUrl.protocol === "http:" ? "http:" : undefined;
	if (scheme === undefined) return false;
	let hostUrl;
	try {
		hostUrl = new URL(`${scheme}//${host}`);
	} catch {
		return false;
	}
	return originUrl.host === hostUrl.host;
}

/**
 * The same request fence the official plugin surface applies: loopback or a
 * configured trusted host, no cross-site fetch, and an Origin that names this
 * listener. The route only reads status, but it also triggers the digest, so
 * it stays fenced.
 * @param {() => object} trust - resolved trustedHosts, bindHost, and protocol.
 * @returns {{ isTrusted: (req: object) => boolean }} the fence.
 */
function createTrustFence(trust) {
	return {
		isTrusted(req) {
			const { trustedHosts, protocol = "http:" } = trust();
			const header = req.headers.host;
			const host = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
			if (!host) return false;
			let hostUrl;
			try {
				hostUrl = new URL(`${protocol}//${host}`);
			} catch {
				return false;
			}
			if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts ?? [], protocol)) return false;
			const site = req.headers["sec-fetch-site"];
			if ((Array.isArray(site) ? site[0] : site) === "cross-site") return false;
			const originHeader = req.headers.origin;
			const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
			if (origin === undefined) return true;
			return isSameAuthorityOrigin(origin, host);
		}
	};
}

/**
 * Write one JSON response.
 * @param {object} res - the server response.
 * @param {unknown} value - the envelope.
 * @param {number} [status] - the HTTP status.
 */
function writeJson(res, value, status = 200) {
	res.statusCode = status;
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

/**
 * Collect the compact work overview the digest, the status tool, and the
 * route all share.
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved options.
 * @param {object} memory - the long-term memory facade.
 * @param {(message: string) => void} log - diagnostic sink.
 * @param {object[]} pendingCandidates - pending memory proposals.
 * @returns {Promise<object>} the overview document.
 */
async function collectOverview(ctx, options, memory, log, pendingCandidates) {
	const now = Date.now();

	/** Read every durable schedule task through the shared schedule service. */
	let catalog = [];
	try {
		catalog = await ctx.schedule?.catalog?.();
	} catch {
		catalog = [];
	}
	const active = catalog
		.filter((entry) => entry.status === "active")
		.map((entry) => ({
			id: entry.id,
			title: entry.title,
			kind: entry.kind,
			rule: describeRule(entry),
			nextFireAt: entry.scheduledAt,
			sessionId: entry.sessionId,
			selector: selectorOf(entry)
		}))
		.sort((a, b) => String(a.nextFireAt).localeCompare(String(b.nextFireAt)));

	/** Recently-updated sessions through the unified session query service:
	 *  `listSessions()` yields the durable records (header rows under
	 *  `header`), `readTitleSnapshots()` their log-backed titles with
	 *  `updatedAt`. Both are read-only and never activate a session. */
	let sessions = [];
	try {
		const records = await ctx.sessionQuery?.listSessions?.();
		const ids = (Array.isArray(records) ? records : [])
			.map((row) => (row !== null && typeof row === "object" && typeof row.header?.id === "string" ? row.header.id : undefined))
			.filter((id) => typeof id === "string")
			.slice(0, Math.max(options.sessionWindowCount * 4, 20));
		const observations = typeof ctx.sessionQuery?.readTitleSnapshots === "function" && ids.length > 0 ? await ctx.sessionQuery.readTitleSnapshots(ids) : [];
		sessions = (Array.isArray(observations) ? observations : [])
			.map((entry) => {
				const id = typeof entry?.sessionId === "string" ? entry.sessionId : undefined;
				const title = typeof entry?.value?.title?.title === "string" ? entry.value.title.title : undefined;
				const updatedAt = typeof entry?.value?.title?.updatedAt === "number" ? entry.value.title.updatedAt : undefined;
				if (id === undefined || typeof title !== "string" || title.trim() === "") return undefined;
				return { id, title: truncate(title, options.maxLineLength), updatedAt };
			})
			.filter((row) => row !== undefined)
			.filter((row) => typeof row.updatedAt !== "number" || now - row.updatedAt <= options.sessionWindowMs)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, options.sessionWindowCount);
	} catch {
		sessions = [];
	}

	/** Remembered notes from the long-term memory store. */
	let memorySummary = { count: 0, latest: [] };
	try {
		const notes = await memory.list();
		memorySummary = {
			count: notes.length,
			latest: notes.slice(0, 5).map((note) => ({ id: note.id, category: note.category, text: truncate(note.text, 60) }))
		};
	} catch (error) {
		log(`overview memory read failed: ${error instanceof Error ? error.message : String(error)}`);
		memorySummary = { count: 0, latest: [] };
	}

	return {
		ok: true,
		generatedAt: new Date(now).toISOString(),
		zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		digest: { enabled: options.digestEnabled, time: options.digestTime },
		schedules: { activeCount: active.length, active: active.slice(0, 20) },
		recentSessions: sessions,
		memory: memorySummary,
		pendingMemories: pendingCandidates.slice(0, 10).map((c) => ({ id: c.id, category: c.category, text: truncate(c.text, 80), createdAt: c.createdAt }))
	};
}

/**
 * Compose the digest notification lines from the overview.
 * @param {object} overview - the collected overview.
 * @param {object} options - resolved options.
 * @returns {{ title: string, body: string }} the notification.
 */
function composeDigest(overview, options) {
	const lines = [];
	const count = overview.schedules.activeCount;
	if (count > 0) {
		const first = overview.schedules.active[0];
		lines.push(`📅 ${count} 个定时任务待办，最近：${truncate(first.title, options.maxLineLength)}（${first.rule}）`);
	} else {
		lines.push("📅 当前没有活跃的定时任务。");
	}
	if (overview.recentSessions.length > 0) {
		const names = overview.recentSessions.slice(0, 3).map((row) => truncate(row.title, 40)).join("、");
		lines.push(`💬 最近推进：${names}`);
	}
	if (overview.pendingMemories.length > 0) {
		lines.push(`🧠 有 ${overview.pendingMemories.length} 条候选记忆等你确认`);
	}
	if (lines.length === 0) lines.push("一切安静，今天也从一句需求开始。");
	return { title: "☕ 早安，这是今天的工作简报", body: lines.join("\n") };
}

/**
 * Register the Host plugin.
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the row's config.
 */
export function apply(ctx, config) {
	const options = resolveOptions(config);
	const log = createLogger(ctx);
	if (options.enabled === false) {
		log("disabled by configuration");
		return;
	}

	/** The long-term memory facade (durable JSON under the Host home). */
	const memory = openMemory(ctx);

	/** Pending candidate memories proposed by the assistant for user confirmation. */
	/** @type {object[]} */
	let pendingCandidates = [];

	/** Load persisted plugin state (onboarding flag + pending candidates). */
	const initState = async () => {
		try {
			const state = await loadState(ctx);
			if (Array.isArray(state.pendingCandidates)) {
				pendingCandidates = state.pendingCandidates.filter((c) => c !== null && typeof c === "object" && typeof c.id === "string" && typeof c.text === "string");
			}
			return state;
		} catch (error) {
			log(`state load failed: ${error instanceof Error ? error.message : String(error)}`);
			return { onboarded: false };
		}
	};

	/** Persist plugin state (onboarding flag + pending candidates). */
	const persistState = async (patch = {}) => {
		try {
			const state = await loadState(ctx);
			state.onboarded = patch.onboarded ?? state.onboarded ?? false;
			if (Array.isArray(pendingCandidates)) state.pendingCandidates = pendingCandidates;
			await saveState(ctx, state);
		} catch (error) {
			log(`state save failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/** Synchronously readable note cache for the prompt section; the section
	 *  text provider must be sync, so it renders from this snapshot and every
	 *  mutating tool refreshes it after its write settles. */
	let cachedNotes = [];
	const refreshNotes = async () => {
		try {
			cachedNotes = await memory.list();
		} catch (error) {
			log(`memory read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	refreshNotes();

	const trust = () => {
		const runtime = ctx.get("webRuntime");
		const startup = ctx.get("webStartup");
		return {
			trustedHosts: runtime?.trustedHosts ?? startup?.trustedHosts ?? [],
			bindHost: ctx.webServer?.host,
			protocol: ctx.webServer?.protocol ?? "http:"
		};
	};

	/** Confirm one pending candidate and move it into durable memory. */
	const confirmPending = async (id) => {
		const idx = pendingCandidates.findIndex((c) => c.id === id);
		if (idx === -1) return { ok: false, error: "not_found" };
		const candidate = pendingCandidates[idx];
		const note = await memory.add({ text: candidate.text, category: candidate.category });
		pendingCandidates.splice(idx, 1);
		await refreshNotes();
		await persistState();
		return { ok: true, note };
	};

	/** Ignore one pending candidate. */
	const ignorePending = async (id) => {
		const before = pendingCandidates.length;
		pendingCandidates = pendingCandidates.filter((c) => c.id !== id);
		if (pendingCandidates.length < before) await persistState();
		return { ok: pendingCandidates.length < before };
	};

	/** One cached overview shared by the route, refreshed on change and by a
	 *  slow wall clock so a long-lived page never sees stale facts. */
	let cache = { at: 0, value: undefined, pending: undefined };
	const overview = async () => {
		if (cache.value !== undefined && Date.now() - cache.at < 15000) return cache.value;
		cache.pending ??= collectOverview(ctx, options, memory, log, pendingCandidates)
			.then((value) => {
				cache = { at: Date.now(), value, pending: undefined };
				return value;
			})
			.catch(() => {
				cache.pending = undefined;
				return collectOverview(ctx, options, memory, log, pendingCandidates);
			});
		return cache.pending;
	};

	/** First-time onboarding: give users an immediate "magic moment". */
	const runOnboarding = async () => {
		try {
			const state = await initState();
			if (state.onboarded === true) return;
			const notes = await memory.list();
			if (notes.length > 0) {
				await persistState({ onboarded: true });
				return;
			}
			await memory.add({ text: "用户偏好用中文交流。", category: "preference" });
			await refreshNotes();
			await persistState({ onboarded: true });
			await deliver(
				{
					title: "🧠 DSH 宝已就绪",
					body: "我会记住你确认过的信息，下次不用重复说。试试对我说：'记住我偏好用中文'。"
				},
				options,
				log
			);
			log("onboarding completed");
		} catch (error) {
			log(`onboarding failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	if (options.onboardingEnabled) {
		void runOnboarding();
	} else {
		void initState();
	}

	/** The JSON route the panel reads and the digest check can trigger. */
	ctx.effect(() => {
		const fence = createTrustFence(trust);
		const handler = async (req, res) => {
			if (!fence.isTrusted(req)) {
				writeJson(res, { ok: false, error: { code: "forbidden", message: "untrusted host" } }, 403);
				return;
			}
			const path = (req.url ?? "").split(/[?#]/, 1)[0];
			try {
				if (path === `${options.routePath}/overview`) {
					writeJson(res, { ok: true, value: await overview() });
					return;
				}
				if (path === `${options.routePath}/pending-memories`) {
					writeJson(res, { ok: true, value: pendingCandidates.slice(0, options.pendingMemoryMax) });
					return;
				}
				if (path === `${options.routePath}/confirm-pending` && req.method === "POST") {
					let body = "";
					for await (const chunk of req) body += chunk;
					const { id } = JSON.parse(body);
					const result = await confirmPending(id);
					cache = { at: 0, value: undefined, pending: undefined };
					writeJson(res, result);
					return;
				}
				if (path === `${options.routePath}/ignore-pending` && req.method === "POST") {
					let body = "";
					for await (const chunk of req) body += chunk;
					const { id } = JSON.parse(body);
					const result = await ignorePending(id);
					cache = { at: 0, value: undefined, pending: undefined };
					writeJson(res, result);
					return;
				}
				writeJson(res, { ok: false, error: { code: "not_found", message: `unknown endpoint ${path}` } }, 404);
			} catch (error) {
				log(`route failed: ${error instanceof Error ? error.message : String(error)}`);
				writeJson(res, { ok: false, error: { code: "bao_api_error", message: "internal error" } }, 500);
			}
		};
		return ctx.webServer.register({ kind: "prefix", path: options.routePath, handler });
	}, "dsh-bao: routes");

	/** Refresh the cached overview when the durable task set changes. */
	ctx.on("schedule/changed", () => {
		cache = { at: 0, value: undefined, pending: undefined };
	});

	/** The daily digest: one interval checks the wall clock against the next
	 *  computed fire time; both the interval and the pending timer ride the
	 *  plugin effect so unload cancels them. */
	ctx.effect(() => {
		if (options.digestEnabled === false) return;
		let fireAt = Date.now() + nextDailyFire(options.digestTime, Date.now());
		log(`digest scheduled at ${options.digestTime} (${Math.round(fireAt - Date.now())}ms from now)`);
		const fire = async () => {
			try {
				const value = await collectOverview(ctx, options, memory, log, pendingCandidates);
				const notification = composeDigest(value, options);
				const channel = await deliver(notification, options, log);
				log(`digest delivered through ${channel}`);
			} catch (error) {
				log(`digest failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		const timer = setInterval(() => {
			if (Date.now() >= fireAt) {
				fireAt = Date.now() + nextDailyFire(options.digestTime, Date.now());
				void fire();
			}
		}, 60000);
		timer.unref?.();
		return () => clearInterval(timer);
	}, "dsh-bao: digest");

	/** Long-term memory into every agent's context: one dynamic runtime-context
	 *  entry re-evaluated at every prompt assembly, so a note the model just
	 *  wrote is visible from its very next step. A context (not a section) is
	 *  the supported extension point: a `complete: true` persona section
	 *  replaces every other section, but contexts always render.
	 *  `interpolate: false` keeps note text literal (a stray `{{...}}` in a
	 *  note must not break prompt assembly). */
	if (options.memoryInject) {
		ctx.inject(["systemPrompt"], (promptCtx) => {
			promptCtx.effect(
				() =>
					promptCtx.systemPrompt.context({
						name: "dsh-bao:memory",
						order: 300,
						interpolate: false,
						text: () => {
							const parts = [];
							if (cachedNotes.length > 0) {
								const lines = cachedNotes.slice(0, options.memoryInjectLimit).map((note) => `- [${note.category}] ${truncate(note.text, options.memoryNoteMaxChars)}`);
								parts.push(`主人的长期记忆（dsh-bao 自动维护，跨会话有效）：\n${lines.join("\n")}\n以上是用户偏好、项目事实与决策的持久记录，回答与决策时优先遵循；与当前请求冲突时以当前请求为准。`);
							}
							if (pendingCandidates.length > 0) {
								const lines = pendingCandidates.slice(0, 5).map((c) => `- [${c.category}] ${truncate(c.text, options.memoryNoteMaxChars)}`);
								parts.push(`以下候选记忆等待用户确认。如果用户在后续对话中确认了某条，调用 bao_confirm_memory；如果明确拒绝，调用 bao_ignore_memory；否则保持 pending 状态，不要在回复中假装它们已经是正式记忆：\n${lines.join("\n")}`);
							}
							if (options.autoExtractMemory) {
								parts.push(`自动记忆提取已启用。当对话中出现值得跨会话保留的偏好、项目、决策或事实，而用户没有明确说"记住"时，你可以调用 bao_extract_memory 把候选记下来，让用户在面板里一键确认。不要记录普通对话内容。`);
							}
							return parts.join("\n\n");
						}
					}),
				"dsh-bao: memory context"
			);
		});
	}

	/** The assistant tools, only when this profile composed a tool registry. */
	ctx.inject(["tools"], (toolCtx) => {
		toolCtx.effect(() => {
			const registrations = [];
			if (options.notifyTool) {
				registrations.push(
					toolCtx.tools.register({
						name: "bao_notify",
						description:
							"以个人助理的身份给用户发一条桌面通知（系统弹窗）。适合主动汇报：定时汇总、任务完成、需要用户决策。不要用于普通进度播报。",
						parameters: {
							type: "object",
							properties: {
								title: { type: "string", description: "通知标题，一句话。例如：任务推进提醒。" },
								body: { type: "string", description: "通知正文，说明发生了什么、需要用户做什么。" }
							},
							required: ["title", "body"],
							additionalProperties: false
						},
						output: {
							schema: {
								type: "object",
								additionalProperties: false,
								properties: {
									delivered: { type: "boolean" },
									channel: { type: "string" }
								},
								required: ["delivered", "channel"]
							},
							render: (_args, value) => [
								{
									type: "text",
									text:
										value.delivered === true
											? `桌面通知已发送（通道：${value.channel}）。`
											: "桌面通知发送失败：当前环境没有可用的通知通道。"
								}
							]
						},
						async execute(args) {
							const title = typeof args?.title === "string" && args.title.trim().length > 0 ? args.title.trim() : "DSH 宝";
							const body = typeof args?.body === "string" ? args.body : "";
							const channel = await deliver({ title, body }, options, log);
							return { delivered: channel !== "none", channel };
						},
						presentCall(args) {
							return {
								card: "generic",
								title: `桌面通知：${args?.title ?? ""}`,
								kind: "other",
								rawInput: args?.body
							};
						}
					})
				);
			}
			if (options.statusTool) {
				registrations.push(
					toolCtx.tools.register({
						name: "bao_status",
						description:
							"查看当前工作状态速览：活跃的定时任务（含规则与下次触发时间）、最近推进的会话、长期记忆概览和待确认候选记忆。回答“最近在忙什么 / 有哪些待办提醒”时先调用它。",
						parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
						output: {
							schema: { type: "string" },
							render: (_args, value) => [{ type: "text", text: value }]
						},
						async execute() {
							const snapshot = await overview();
							const lines = [];
							lines.push(`工作状态速览（${snapshot.generatedAt}，时区 ${snapshot.zone}）：`);
							if (snapshot.schedules.activeCount > 0) {
								lines.push(`活跃定时任务 ${snapshot.schedules.activeCount} 个：`);
								for (const task of snapshot.schedules.active.slice(0, 8)) {
									lines.push(`  - ${task.title}（${task.rule}，下次 ${task.nextFireAt}）`);
								}
							} else {
								lines.push("活跃定时任务：无。需要的话可以用 schedule_create 创建。");
							}
							if (snapshot.recentSessions.length > 0) {
								lines.push("最近推进的会话：");
								for (const row of snapshot.recentSessions) lines.push(`  - ${row.title}`);
							}
							if (snapshot.memory.count > 0) {
								lines.push(`长期记忆 ${snapshot.memory.count} 条，最新：`);
								for (const note of snapshot.memory.latest) lines.push(`  - [${note.category}] ${note.text}`);
							}
							if (snapshot.pendingMemories.length > 0) {
								lines.push(`候选记忆 ${snapshot.pendingMemories.length} 条等你确认：`);
								for (const c of snapshot.pendingMemories) lines.push(`  - [${c.category}] ${c.text}`);
							}
							return lines.join("\n");
						}
					})
				);
			}
			if (options.memoryTools) {
				registrations.push(
					toolCtx.tools.register({
						name: "bao_remember",
						description:
							"记住一条关于用户的长期信息（偏好、项目背景、决策、事实），跨会话生效。用户说“记住…”、“以后都…”、“我的习惯是…”时调用。不要记录普通对话内容。",
						parameters: {
							type: "object",
							properties: {
								text: { type: "string", description: "要记住的内容，一句话，第三人称。例如：用户偏好用中文交流。" },
								category: { type: "string", enum: NOTE_CATEGORIES, description: "类别：preference=偏好、project=项目、decision=决策、fact=事实、other=其他" }
							},
							required: ["text"],
							additionalProperties: false
						},
						output: {
							schema: { type: "string" },
							render: (_args, value) => [{ type: "text", text: value }]
						},
						async execute(args, toolAgent) {
							const text = typeof args?.text === "string" ? args.text.trim() : "";
							if (text === "") return "没有可记住的内容。";
							const note = await memory.add({ text, category: args?.category, sourceSessionId: toolAgent?.session?.id });
							await refreshNotes();
							return `已记住（${note.category}）：${truncate(note.text, 80)}`;
						}
					})
				);
				registrations.push(
					toolCtx.tools.register({
						name: "bao_recall",
						description: "检索长期记忆：按关键词过滤（可选），返回所有匹配的持久笔记。",
						parameters: {
							type: "object",
							properties: {
								keyword: { type: "string", description: "可选关键词过滤器" }
							},
							required: [],
							additionalProperties: false
						},
						output: {
							schema: { type: "string" },
							render: (_args, value) => [{ type: "text", text: value }]
						},
						async execute(args) {
							await refreshNotes();
							const keyword = typeof args?.keyword === "string" ? args.keyword.trim().toLowerCase() : "";
							const matched = keyword === "" ? cachedNotes : cachedNotes.filter((note) => note.text.toLowerCase().includes(keyword) || note.category.toLowerCase().includes(keyword));
							if (matched.length === 0) return "长期记忆中没有匹配的笔记。";
							return matched.map((note) => `[${note.category}] ${note.text}（${new Date(note.createdAt).toLocaleString()}）`).join("\n");
						}
					})
				);
				registrations.push(
					toolCtx.tools.register({
						name: "bao_forget",
						description: "删除长期记忆：按 id 精确删除一条，或按关键词删除所有匹配的笔记。",
						parameters: {
							type: "object",
							properties: {
								id: { type: "string", description: "要删除的笔记 id（精确）" },
								keyword: { type: "string", description: "或按关键词删除所有匹配笔记" }
							},
							required: [],
							additionalProperties: false
						},
						output: {
							schema: { type: "string" },
							render: (_args, value) => [{ type: "text", text: value }]
						},
						async execute(args) {
							if (typeof args?.id === "string" && args.id !== "") {
								const removed = await memory.remove(args.id);
								if (removed) {
									await refreshNotes();
									return "已删除。";
								}
								return "没有找到这条笔记。";
							}
							if (typeof args?.keyword === "string" && args.keyword.trim() !== "") {
								const removed = await memory.removeMatching(args.keyword);
								if (removed > 0) {
									await refreshNotes();
									return `已删除 ${removed} 条匹配笔记。`;
								}
								return "没有匹配的笔记。";
							}
							return "需要提供 id 或 keyword。";
						}
					})
				);
				if (options.autoExtractMemory) {
					registrations.push(
						toolCtx.tools.register({
							name: "bao_extract_memory",
							description:
								"从当前对话中自动提取值得跨会话保留的候选记忆。当对话中出现偏好、项目、决策或事实，而用户没有明确说'记住'时调用。每个候选需要 text 和 category，存入待确认列表，用户稍后在面板或工具中一键确认。不要记录普通闲聊内容。",
							parameters: {
								type: "object",
								properties: {
									candidates: {
										type: "array",
										items: {
											type: "object",
											properties: {
												text: { type: "string", description: "候选记忆内容，一句话，第三人称。" },
												category: { type: "string", enum: NOTE_CATEGORIES, description: "类别：preference/project/decision/fact/other" }
											},
											required: ["text", "category"],
											additionalProperties: false
										}
									}
								},
								required: ["candidates"],
								additionalProperties: false
							},
							output: {
								schema: { type: "string" },
								render: (_args, value) => [{ type: "text", text: value }]
							},
							async execute(args) {
								const list = Array.isArray(args?.candidates) ? args.candidates : [];
								if (list.length === 0) return "没有提供候选记忆。";
								const now = Date.now();
								let added = 0;
								for (const item of list) {
									const text = typeof item?.text === "string" ? item.text.trim() : "";
									const category = NOTE_CATEGORIES.includes(item?.category) ? item.category : "other";
									if (text === "") continue;
									if (pendingCandidates.some((c) => c.text === text)) continue;
									pendingCandidates.push({ id: `bao-pending-${randomUUID()}`, text, category, createdAt: now });
									if (pendingCandidates.length > options.pendingMemoryMax) pendingCandidates.shift();
									added++;
								}
								if (added === 0) return "没有新的候选记忆需要保存。";
								cache = { at: 0, value: undefined, pending: undefined };
								await persistState();
								void deliver(
									{
										title: "🧠 发现候选记忆",
										body: `DSH 宝从刚才的对话中提取了 ${added} 条候选记忆，打开面板可以一键确认或忽略。`
									},
									options,
									log
								);
								return `已保存 ${added} 条候选记忆，等待你确认。`;
							}
						})
					);
					registrations.push(
						toolCtx.tools.register({
							name: "bao_confirm_memory",
							description: "确认一条候选记忆，将其转为正式长期记忆。",
							parameters: {
								type: "object",
								properties: {
									id: { type: "string", description: "候选记忆 id" }
								},
								required: ["id"],
								additionalProperties: false
							},
							output: {
								schema: { type: "string" },
								render: (_args, value) => [{ type: "text", text: value }]
							},
							async execute(args) {
								const id = typeof args?.id === "string" ? args.id : "";
								if (id === "") return "需要提供候选记忆 id。";
								const result = await confirmPending(id);
								if (!result.ok) return "没有找到这条候选记忆。";
								return `已确认并加入长期记忆（${result.note.category}）：${truncate(result.note.text, 80)}`;
							}
						})
					);
					registrations.push(
						toolCtx.tools.register({
							name: "bao_ignore_memory",
							description: "忽略一条候选记忆，将其从待确认列表中移除。",
							parameters: {
								type: "object",
								properties: {
									id: { type: "string", description: "候选记忆 id" }
								},
								required: ["id"],
								additionalProperties: false
							},
							output: {
								schema: { type: "string" },
								render: (_args, value) => [{ type: "text", text: value }]
							},
							execute(args) {
								const id = typeof args?.id === "string" ? args.id : "";
								if (id === "") return "需要提供候选记忆 id。";
								const result = ignorePending(id);
								return result.ok ? "已忽略。" : "没有找到这条候选记忆。";
							}
						})
					);
				}
			}
			return () => {
				for (const off of registrations) off();
			};
		}, "dsh-bao: tools");
	});
}

/** Load-order requirements: the web route, the session store, the durable
 *  schedule catalog, the unified session query service, the prompt registry
 *  (memory section), and the tool registry (memory tools). */
export const inject = ["webServer", "sessions", "schedule", "sessionQuery", "systemPrompt", "tools"];
