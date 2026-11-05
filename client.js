window.__ModuleLoader__.load({
	id: "dsh-bao",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		/** The panel id the sidebar entry and the main panel share. */
		const PANEL_ID = "dsh-bao";
		const LOCALE_NS = "dsh-bao";

		/** In-component styles; React removes them on unmount and every color
		 *  rides the host theme tokens, so light/dark follows the app. */
		const styles = {
			page: {
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				boxSizing: "border-box",
				height: "100%",
				overflow: "auto",
				padding: "0 clamp(24px, 4vw, 48px) 48px",
				color: "var(--dsw-alias-label-primary)"
			},
			inner: { width: "100%", maxWidth: "760px" },
			backRow: { display: "flex", padding: "18px 0 8px" },
			back: {
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				border: "none",
				background: "none",
				color: "var(--dsw-alias-label-secondary)",
				font: "inherit",
				fontSize: "13px",
				padding: "6px 10px",
				marginLeft: "-10px",
				borderRadius: "8px",
				cursor: "pointer"
			},
			head: { display: "flex", alignItems: "center", gap: "12px", margin: "8px 0 4px" },
			mark: {
				width: "40px",
				height: "40px",
				borderRadius: "12px",
				flex: "none",
				boxShadow: "0 1px 6px rgba(0,0,0,0.12)"
			},
			title: { fontSize: "20px", fontWeight: 600, margin: 0 },
			subtitle: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", margin: "2px 0 0" },
			card: {
				marginTop: "16px",
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: "12px",
				padding: "14px 16px"
			},
			cardTitle: {
				fontSize: "12px",
				fontWeight: 600,
				letterSpacing: "0.04em",
				textTransform: "uppercase",
				color: "var(--dsw-alias-label-secondary)",
				margin: "0 0 10px"
			},
			row: { display: "flex", alignItems: "baseline", gap: "8px", padding: "6px 0", fontSize: "13px" },
			rowMain: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rowSub: { color: "var(--dsw-alias-label-secondary)", flex: "none", fontSize: "12px" },
			empty: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", padding: "4px 0" },
			error: { color: "var(--dsw-alias-state-error-primary)", fontSize: "13px" },
			dot: {
				display: "inline-block",
				width: "8px",
				height: "8px",
				borderRadius: "50%",
				background: "var(--dsw-alias-state-success-primary)",
				marginRight: "6px",
				flex: "none"
			},
			digestTime: { color: "var(--dsw-alias-label-secondary)" },
			chat: {
				display: "inline-flex",
				alignItems: "center",
				gap: "8px",
				border: "none",
				borderRadius: "10px",
				background: "#d8532f",
				color: "#ffffff",
				font: "inherit",
				fontSize: "14px",
				fontWeight: 600,
				padding: "9px 18px",
				cursor: "pointer"
			},
			noteCategory: {
				flex: "none",
				fontSize: "11px",
				color: "var(--dsw-alias-label-secondary)",
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: "6px",
				padding: "1px 6px"
			}
		};

		/** The sidebar glyph; the sidebar owns the button, label, and selection. */
		function BaoPanelIcon({ size }) {
			return h(
				"svg",
				{ viewBox: "0 0 64 64", width: size, height: size, "aria-hidden": true },
				h("circle", { cx: 32, cy: 32, r: 24, fill: "#d8532f" }),
				h("circle", { cx: 32, cy: 26, r: 9, fill: "#ffffff" }),
				h("path", {
					d: "M 16 48 C 18 38, 26 33, 32 33 C 38 33, 46 38, 48 48 Z",
					fill: "#ffffff"
				})
			);
		}

		/** One digest/overview fact row. */
		function FactRow({ main, sub }) {
			return h("div", { style: styles.row }, h("div", { style: styles.rowMain }, main), sub !== undefined && h("div", { style: styles.rowSub }, sub));
		}

		/** The panel body: fetch the overview and render the two fact cards. */
		function BaoPanel({ t }) {
			const [state, setState] = React.useState({ loading: true, overview: undefined, error: undefined });
			React.useEffect(() => {
				let alive = true;
				const controller = new AbortController();
				const load = () => {
					fetch("bao/api/overview", { signal: controller.signal })
						.then((res) => res.json())
						.then((wire) => {
							if (!alive) return;
							if (wire && wire.ok === true) setState({ loading: false, overview: wire.value, error: undefined });
							else setState({ loading: false, overview: undefined, error: wire?.error?.message ?? "unknown error" });
						})
						.catch((err) => {
							if (!alive || controller.signal.aborted) return;
							setState({ loading: false, overview: undefined, error: err instanceof Error ? err.message : String(err) });
						});
				};
				load();
				const timer = setInterval(load, 30000);
				return () => {
					alive = false;
					clearInterval(timer);
					controller.abort();
				};
			}, []);
			if (state.loading && state.overview === undefined) {
				return h("div", { style: styles.empty }, t("loading"));
			}
			if (state.error !== undefined && state.overview === undefined) {
				return h("div", { style: styles.error }, `${t("loadFailed")}: ${state.error}`);
			}
			const overview = state.overview;
			const digest = overview.digest ?? {};
			return h(
				React.Fragment,
				null,
				h(
					"div",
					{ style: styles.card },
					h("div", { style: styles.cardTitle }, t("schedulesTitle")),
					overview.schedules.activeCount > 0
						? overview.schedules.active.slice(0, 8).map((task) =>
								h(FactRow, {
									key: task.id,
									main: `${task.title}`,
									sub: `${task.rule} · ${new Date(task.nextFireAt).toLocaleString()}`
								})
							)
						: h("div", { style: styles.empty }, t("schedulesEmpty")),
					overview.schedules.activeCount > 8 ? h("div", { style: styles.empty }, `+${overview.schedules.activeCount - 8}`) : null
				),
				h(
					"div",
					{ style: styles.card },
					h("div", { style: styles.cardTitle }, t("sessionsTitle")),
					overview.recentSessions.length > 0
						? overview.recentSessions.map((row) =>
								h(FactRow, {
									key: row.id,
									main: row.title,
									sub: typeof row.updatedAt === "number" ? new Date(row.updatedAt).toLocaleString() : undefined
								})
							)
						: h("div", { style: styles.empty }, t("sessionsEmpty"))
				),
				h(
					"div",
					{ style: styles.card },
					h("div", { style: styles.cardTitle }, t("memoryTitle")),
					(overview.memory?.latest?.length ?? 0) > 0
						? overview.memory.latest.map((note) =>
								h(FactRow, {
									key: note.id,
									main: h(
										"span",
										{ style: { display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 } },
										h("span", { style: styles.noteCategory }, note.category),
										h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, note.text)
									)
								})
							)
						: h("div", { style: styles.empty }, t("memoryEmpty")),
					(overview.memory?.count ?? 0) > overview.memory.latest.length ? h("div", { style: styles.empty }, `+${overview.memory.count - overview.memory.latest.length}`) : null
				),
				h(
					"div",
					{ style: styles.card },
					h("div", { style: styles.cardTitle }, t("digestTitle")),
					digest.enabled === true
						? h(FactRow, {
								main: h("span", null, h("span", { style: styles.dot }), t("digestOn")),
								sub: h("span", { style: styles.digestTime }, digest.time)
							})
						: h(FactRow, { main: t("digestOff") })
				)
			);
		}

		/** The standalone main panel with its own back control, mirroring the
		 *  shipped page-plugin chrome. */
		function BaoPanelPage({ goBack, onChat, t }) {
			return h(
				"div",
				{ style: styles.page },
				h(
					"div",
					{ style: styles.inner },
					h("div", { style: styles.backRow }, h("button", { style: styles.back, type: "button", onClick: goBack }, "‹ ", t("back"))),
					h(
						"div",
						{ style: styles.head },
						h(BaoPanelIcon, { size: styles.mark.width }),
						h("div", null, h("h1", { style: styles.title }, t("title")), h("p", { style: styles.subtitle }, t("subtitle"))),
						h("div", { style: { flex: "1 1 auto" } }),
						h("button", { style: styles.chat, type: "button", onClick: onChat }, t("chat"))
					),
					h(BaoPanel, { t })
				)
			);
		}

		return {
			inject: ["locale", "slots", "layout", "uiWorkspace"],
			apply(ctx) {
				const t = ctx.locale.bind(LOCALE_NS);
				ctx.effect(() => {
					const offZh = ctx.locale.register(LOCALE_NS, "zh", {
						title: "DSH 宝",
						subtitle: "你的个人助理：懂你的记忆、定时简报、桌面通知、状态速览。",
						back: "返回",
						nav: "DSH 宝",
						chat: "和宝聊聊",
						loading: "正在读取工作状态…",
						loadFailed: "读取失败",
						schedulesTitle: "定时任务",
						schedulesEmpty: "没有活跃的定时任务。对助理说“每天早上 9 点提醒我汇总进度”即可创建。",
						sessionsTitle: "最近推进",
						sessionsEmpty: "最近没有推进的会话。",
						memoryTitle: "长期记忆",
						memoryEmpty: "还没有记忆。对助理说“记住我偏好简洁汇报”即可开始积累。",
						digestTitle: "每日简报",
						digestOn: "已开启，每天定时推送桌面通知",
						digestOff: "未开启，可在插件配置中打开"
					});
					const offEn = ctx.locale.register(LOCALE_NS, "en", {
						title: "DSH Bao",
						subtitle: "Your personal assistant: long-term memory, daily digest, desktop notifications, and a live overview.",
						back: "Back",
						nav: "DSH Bao",
						chat: "Chat with Bao",
						loading: "Loading work status…",
						loadFailed: "Failed to load",
						schedulesTitle: "Scheduled tasks",
						schedulesEmpty: "No active scheduled tasks. Ask the assistant to create one.",
						sessionsTitle: "Recently active",
						sessionsEmpty: "No recently active sessions.",
						memoryTitle: "Long-term memory",
						memoryEmpty: "No memories yet. Tell the assistant \"remember I prefer concise reports\" to start.",
						digestTitle: "Daily digest",
						digestOn: "On — one desktop notification every day",
						digestOff: "Off — enable it in the plugin configuration"
					});
					return () => {
						offZh();
						offEn();
					};
				}, "dsh-bao: dictionaries");

				/** Track the previously active panel so Back returns where the user
				 *  came from, mirroring the shipped page plugins. */
				let previousPanelId = null;
				let lastPanelId = ctx.layout.panelInfo.getSnapshot().activePanelId;
				ctx.effect(
					() =>
						ctx.layout.panelInfo.subscribe(() => {
							const next = ctx.layout.panelInfo.getSnapshot().activePanelId;
							if (next === PANEL_ID && lastPanelId !== PANEL_ID) previousPanelId = lastPanelId;
							lastPanelId = next;
						}),
					"dsh-bao: panel history"
				);
				const goBack = () => {
					if (previousPanelId === null || previousPanelId === PANEL_ID) {
						ctx.layout.selectPanel(null);
						return;
					}
					try {
						ctx.layout.selectPanel(previousPanelId);
					} catch {
						ctx.layout.selectPanel(null);
					}
				};

				/** Jump straight into a conversation with Bao: start a session
				 *  composed from the aibao agent preset in the current workspace. */
				const chatWithBao = () => {
					try {
						ctx.uiWorkspace.startSession(undefined, { agentPreset: "aibao" });
					} catch (error) {
						console.error("[dsh-bao] startSession failed", error);
					}
				};

				ctx.slots.inject("main", () =>
					ctx.slots.register({ name: "main", key: PANEL_ID, locale: LOCALE_NS, inject: () => ({ goBack, onChat: chatWithBao }) }, BaoPanelPage)
				);
				ctx.slots.inject("sidebar.panellist", () =>
					ctx.slots.register(
						{ name: "sidebar.panellist", id: PANEL_ID, order: 85, label: () => t("nav"), locale: LOCALE_NS },
						BaoPanelIcon
					)
				);
			}
		};
	}
});
