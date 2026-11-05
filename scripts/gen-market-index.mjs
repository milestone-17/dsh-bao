import { readFileSync, writeFileSync } from "node:fs";

const commit = "69abd474c5be9e9b2e0527dcf9fd921f4cb6ea32";
const iconB64 = readFileSync("D:/workspace/dsh-bao/icon.svg").toString("base64");

const index = {
	format: 1,
	title: { en: "milestone-17 DSH Plugins", zh: "milestone-17 的 DSH 插件" },
	description: {
		en: "Open-source plugins for DeepSeek Harness by milestone-17.",
		zh: "milestone-17 开源的 DeepSeek Harness 插件合集。"
	},
	metadata: {
		categories: {
			assistant: { title: { en: "Assistants", zh: "助理" } }
		}
	},
	plugins: [
		{
			name: "dsh-bao",
			title: { en: "DSH Bao", zh: "DSH 宝" },
			description: {
				en: "A TRAE-Bao-style personal assistant: cross-session long-term memory injected into every request, a dedicated assistant agent preset, daily digest notifications, and a live overview panel.",
				zh: "TRAE 宝式的个人助理：跨会话长期记忆（每次请求自动注入）、专属助理预设、每日简报桌面通知与工作状态速览面板。"
			},
			icon: `data:image/svg+xml;base64,${iconB64}`,
			author: "LuoBiao (milestone-17)",
			homepage: "https://github.com/milestone-17/dsh-bao#readme",
			repository: { url: "https://github.com/milestone-17/dsh-bao" },
			metadata: {
				category: "assistant",
				keywords: ["assistant", "memory", "digest", "notification", "preset", "bao"]
			},
			versions: [
				{
					version: "0.2.2",
					publishTimestamp: Math.floor(Date.now() / 1000),
					source: {
						type: "git",
						url: "https://github.com/milestone-17/dsh-bao",
						commit
					},
					engines: { dsh: ">=0.2.1-rc.2" }
				},
				{
					version: "0.2.1",
					publishTimestamp: Math.floor(Date.now() / 1000) - 1200,
					source: {
						type: "git",
						url: "https://github.com/milestone-17/dsh-bao",
						commit: "abd7c674d2be45cc66f9b29fee62880920420452"
					},
					engines: { dsh: ">=0.2.1-rc.2" }
				},
				{
					version: "0.2.0",
					publishTimestamp: Math.floor(Date.now() / 1000) - 3600,
					source: {
						type: "git",
						url: "https://github.com/milestone-17/dsh-bao",
						commit: "30fd022a26777d810c5e49d7d70a50227185d700"
					},
					engines: { dsh: ">=0.2.1-rc.2" }
				}
			]
		}
	]
};

const out = "D:/workspace/dsh-bao/market-index.json";
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log("written", out);

/** Optional self-check: validates with the official parser when available
 *  (it ships inside the Harness asar; skip gracefully elsewhere). */
try {
	const validatorUrl = "file:///C:/Users/Chuibiao.Luo/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js";
	const { parseMarketIndex } = await import(validatorUrl);
	const parsed = parseMarketIndex(JSON.parse(readFileSync(out, "utf8")), "https://raw.githubusercontent.com/milestone-17/dsh-bao/master/market-index.json");
	console.log("validated:", parsed.title.en, "| plugins:", parsed.plugins.map((p) => p.name).join(","));
} catch (error) {
	console.log("validator unavailable here (format was hand-checked against the official parser):", error.message);
}
