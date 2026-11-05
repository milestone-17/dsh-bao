/**
 * Long-term memory for dsh-bao, stored in one durable JSON document.
 *
 * Location: `$DSH_HOME/bao/memory.json` (the Host home directory the same
 * way sessions and plugin state live under it), written atomically so a
 * crash mid-write cannot corrupt the file. This module deliberately avoids
 * importing any Harness package — plugins from npm must run against only
 * the injected context and Node built-ins, because dsh internals are not a
 * supported dependency surface for third-party bundles.
 *
 * One note carries a category and timestamps; the session log remains the
 * source of truth for conversations (Harness practice #1) — these notes are
 * the distilled, human-meaningful layer on top of it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Categories a note may carry, in display order. */
export const NOTE_CATEGORIES = ["preference", "project", "decision", "fact", "other"];

/** Schema of the on-disk document. */
const DOC_VERSION = 1;

/**
 * Resolve the memory file path from the plugin context.
 * @param {object} ctx - the plugin context.
 * @returns {string} the absolute file path.
 */
function memoryPath(ctx) {
	const home = typeof ctx.dshHomePath === "function" ? ctx.dshHomePath() : process.env.DSH_HOME ?? process.cwd();
	return `${home}/bao/memory.json`;
}

/**
 * One in-process write chain; every read-modify-write queues on it so two
 * concurrent adds cannot interleave and lose a note (the same serialization
 * the domain form applies to its write chain).
 */
let chain = Promise.resolve();

/** @type {object | undefined} the cached parsed document. */
let cache;
/** @type {string | undefined} the resolved file path. */
let filePath;
/** @type {(ctx: object) => object} the context-bound loader. */
let boundLoader;

/**
 * Read the document (cached after first load; callers chain writes through
 * `runSerialized` so the cache never diverges from the medium).
 * @param {object} ctx - the plugin context.
 * @returns {Promise<object>} the parsed document.
 */
async function load(ctx) {
	if (cache !== undefined) return cache;
	filePath ??= memoryPath(ctx);
	let text;
	try {
		text = await readFile(filePath, "utf8");
	} catch {
		cache = { version: DOC_VERSION, notes: [] };
		return cache;
	}
	try {
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.notes)) {
			cache = { version: DOC_VERSION, notes: parsed.notes.filter((note) => note !== null && typeof note === "object" && typeof note.id === "string" && typeof note.text === "string") };
		} else {
			cache = { version: DOC_VERSION, notes: [] };
		}
	} catch {
		// A corrupted document starts fresh rather than failing every tool;
		// the previous bytes stay on disk until the next successful write
		// replaces them, so nothing is lost by the failed parse itself.
		cache = { version: DOC_VERSION, notes: [] };
	}
	return cache;
}

/**
 * Durably write the document atomically (temp file + rename).
 * @param {object} doc - the document to persist.
 * @returns {Promise<void>} resolution after the rename.
 */
async function persist(doc) {
	filePath ??= memoryPath(boundContext);
	await mkdir(dirname(filePath), { recursive: true });
	const temp = `${filePath}.${randomUUID()}.tmp`;
	await writeFile(temp, JSON.stringify(doc, null, 2), "utf8");
	await rename(temp, filePath);
}

/**
 * Run one read-modify-write cycle on the serialized chain.
 * @template T
 * @param {(doc: object) => T | Promise<T>} work - the mutation over the loaded document.
 * @returns {Promise<T>} the work's resolution.
 */
function runSerialized(work) {
	const result = chain.then(() => work(cache));
	chain = result.then(() => undefined, () => undefined);
	return result;
}

/** The context captured at first use, for path resolution inside writes. */
let boundContext;

/**
 * The memory facade bound to one plugin context.
 * @param {object} ctx - the plugin context.
 * @returns {object} the memory facade.
 */
export function openMemory(ctx) {
	boundContext ??= ctx;
	boundLoader ??= ctx;
	return {
		/**
		 * List every note, newest first.
		 * @returns {Promise<object[]>} the notes.
		 */
		async list() {
			const doc = await load(ctx);
			return [...doc.notes].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		},
		/**
		 * Add one note.
		 * @param {{ text: string, category?: string, sourceSessionId?: string, now?: number }} input - the note fields.
		 * @returns {Promise<object>} the stored note.
		 */
		add(input) {
			return runSerialized(async () => {
				const doc = await load(ctx);
				const now = typeof input.now === "number" ? input.now : Date.now();
				const category = NOTE_CATEGORIES.includes(input.category) ? input.category : "other";
				const note = {
					id: `bao-note-${randomUUID()}`,
					text: String(input.text).trim().slice(0, 4000),
					category,
					createdAt: now,
					updatedAt: now,
					...(typeof input.sourceSessionId === "string" ? { sourceSessionId: input.sourceSessionId } : {})
				};
				doc.notes.push(note);
				await persist(doc);
				return note;
			});
		},
		/**
		 * Remove one note by id.
		 * @param {string} id - the note id.
		 * @returns {Promise<boolean>} whether a note was removed.
		 */
		remove(id) {
			return runSerialized(async () => {
				const doc = await load(ctx);
				const before = doc.notes.length;
				doc.notes = doc.notes.filter((note) => note.id !== id);
				if (doc.notes.length === before) return false;
				await persist(doc);
				return true;
			});
		},
		/**
		 * Remove every note whose text or category matches a keyword.
		 * @param {string} keyword - the match keyword.
		 * @returns {Promise<number>} how many notes were removed.
		 */
		removeMatching(keyword) {
			return runSerialized(async () => {
				const doc = await load(ctx);
				const needle = keyword.trim().toLowerCase();
				const before = doc.notes.length;
				doc.notes = doc.notes.filter((note) => !note.text.toLowerCase().includes(needle) && !String(note.category).toLowerCase().includes(needle));
				const removed = before - doc.notes.length;
				if (removed > 0) await persist(doc);
				return removed;
			});
		}
	};
}

/** Reset cached state (test seam only). */
export function _resetMemoryForTests() {
	cache = undefined;
	filePath = undefined;
	boundContext = undefined;
}
