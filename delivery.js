/**
 * Operating-system notification delivery for dsh-bao.
 *
 * Two channels are tried in order:
 *
 *  1. Electron's native `Notification`. The Desktop shell runs the Web Host
 *     inside an Electron process, so the toast carries the application's own
 *     identity and icon.
 *  2. A Windows toast through Windows PowerShell 5.1 and the WinRT toast API.
 *     Plain Node Hosts (the `dsh` CLI, a remote worker) have no Electron
 *     module, and this channel works from any process.
 *
 * Both channels are fire-and-forget: a failure never breaks the session.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Start Menu identity of the installed DeepSeek Harness application. */
export const DEFAULT_APP_USER_MODEL_ID = "com.deepseek.dsh";

/** How long to wait for Electron to become ready before using another channel. */
const ELECTRON_READY_TIMEOUT_MS = 1500;

/**
 * Load the Electron module when this process is an Electron runtime.
 * @returns {object | undefined} the Electron module, or undefined outside Electron.
 */
export function loadElectron() {
	try {
		const electron = require("electron");
		if (electron !== undefined && electron !== null && typeof electron.Notification === "function") return electron;
	} catch {
		// Plain Node process: the Windows toast channel serves this Host.
	}
	return undefined;
}

/**
 * Wait until Electron reports the application as ready.
 * @param {object | undefined} app - the Electron `app` module.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<boolean>} true when the application is ready.
 */
async function waitForElectronReady(app, timeoutMs) {
	if (app === undefined || app === null) return false;
	try {
		if (typeof app.isReady === "function" && app.isReady()) return true;
		if (typeof app.whenReady !== "function") return false;
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		try {
			return await Promise.race([app.whenReady().then(() => true, () => false), timeout]);
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

/**
 * Show one notification through Electron's native notification service.
 * @param {object} electron - the Electron module.
 * @param {{ title: string, body: string }} notification - the notification content.
 * @param {object} options - delivery options.
 * @param {(message: string) => void} [log] - diagnostic sink.
 * @returns {Promise<boolean>} true when the notification was handed to Electron.
 */
export async function sendViaElectron(electron, notification, options = {}, log) {
	const appUserModelId = options.appUserModelId ?? DEFAULT_APP_USER_MODEL_ID;
	try {
		if (typeof electron.app?.setAppUserModelId === "function") {
			try {
				electron.app.setAppUserModelId(appUserModelId);
			} catch {
				// Keep the default identity when the platform refuses the change.
			}
		}
		if (typeof electron.Notification.isSupported === "function" && !electron.Notification.isSupported()) {
			log?.("electron reports that notifications are unsupported");
			return false;
		}
		const ready = await waitForElectronReady(electron.app, options.electronReadyTimeoutMs ?? ELECTRON_READY_TIMEOUT_MS);
		if (!ready) {
			log?.("electron application is not ready yet");
			return false;
		}
		const toast = new electron.Notification({
			title: notification.title,
			body: notification.body,
			silent: options.sound === false
		});
		toast.show();
		return true;
	} catch (error) {
		log?.(`electron notification failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/**
 * Show one notification as a native Windows toast.
 * @param {{ title: string, body: string }} notification - the notification content.
 * @param {object} options - delivery options.
 * @param {(message: string) => void} [log] - diagnostic sink.
 * @returns {boolean} true when the toast process was started.
 */
export function sendViaWindowsToast(notification, options = {}, log) {
	if (process.platform !== "win32") return false;
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
	if (!existsSync(powershell)) {
		log?.("Windows PowerShell 5.1 is unavailable");
		return false;
	}
	const script = fileURLToPath(new URL("./toast.ps1", import.meta.url));
	try {
		const child = spawn(
			powershell,
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				script,
				"-Title",
				notification.title,
				"-Body",
				notification.body,
				"-AppUserModelId",
				options.appUserModelId ?? DEFAULT_APP_USER_MODEL_ID
			],
			{ detached: true, stdio: "ignore", windowsHide: true }
		);
		child.on("error", (error) => log?.(`windows toast failed: ${error.message}`));
		child.unref();
		return true;
	} catch (error) {
		log?.(`windows toast could not start: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/**
 * Deliver one notification through the first channel that accepts it.
 * @param {{ title: string, body: string }} notification - the notification content.
 * @param {object} [options] - delivery options.
 * @param {(message: string) => void} [log] - diagnostic sink.
 * @returns {Promise<string>} the channel that accepted the notification.
 */
export async function deliver(notification, options = {}, log) {
	const electron = options.electron ?? loadElectron();
	if (electron !== undefined && (await sendViaElectron(electron, notification, options, log))) {
		return "electron";
	}
	if (sendViaWindowsToast(notification, options, log)) return "windows-toast";
	return "none";
}
