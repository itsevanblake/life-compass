import { Plugin, PluginSettingTab, MarkdownRenderChild, App, Setting, Notice, TFile } from "obsidian";
import { createClient, SupabaseClient, Session, RealtimeChannel } from "@supabase/supabase-js";

// The seven Wheel of Life categories, matching Goals/Vision.md's H2
// headings exactly (this is how ratings/prose are matched back to that
// file — keep these two lists in sync if Vision.md's structure changes).
interface WheelCategory {
	key: string;
	heading: string;
}

const WHEEL_CATEGORIES: WheelCategory[] = [
	{ key: "career-business", heading: "Career / Business" },
	{ key: "money", heading: "Money" },
	{ key: "health", heading: "Health" },
	{ key: "relationships", heading: "Relationships" },
	{ key: "lifestyle", heading: "Lifestyle" },
	{ key: "personal-growth", heading: "Personal Growth" },
	{ key: "contribution", heading: "Contribution" },
];

interface PluginData {
	// category key -> 1-10 satisfaction rating. Missing key = not yet rated.
	wheelRatings: Record<string, number>;
}

const DEFAULT_DATA: PluginData = { wheelRatings: {} };

interface PluginSettings {
	supabaseUrl: string;
	supabaseAnonKey: string;
}

const DEFAULT_SETTINGS: PluginSettings = { supabaseUrl: "", supabaseAnonKey: "" };

// Minimal shape of what we read from the habit-tracker plugin, if
// installed/enabled — cross-plugin interop, not a shared codebase. Only
// the fields this plugin actually needs.
interface LinkedHabitLite {
	id: string;
	name: string;
	color: string;
	linkedGoal?: string;
}

function getHabitTrackerHabits(app: App): LinkedHabitLite[] | null {
	const anyApp = app as unknown as { plugins: { plugins: Record<string, { data?: { habits?: LinkedHabitLite[] } }> } };
	const habitPlugin = anyApp.plugins?.plugins?.["habit-tracker"];
	return habitPlugin?.data?.habits ?? null;
}

function getHabitStreak(app: App, habitId: string): number {
	const anyApp = app as unknown as {
		plugins: { plugins: Record<string, { data?: { entries?: Record<string, Record<string, unknown>> } }> };
	};
	const entries = anyApp.plugins?.plugins?.["habit-tracker"]?.data?.entries?.[habitId];
	if (!entries) return 0;
	let streak = 0;
	let missStreak = 0;
	let cursor = new Date();
	let isToday = true;
	while (true) {
		const dateStr = formatDate(cursor);
		if (entries[dateStr]) {
			streak++;
			missStreak = 0;
		} else if (!isToday) {
			missStreak++;
			if (missStreak >= 2) break;
		}
		isToday = false;
		cursor = new Date(cursor.getTime() - 86400000);
	}
	return streak;
}

function formatDate(d: Date): string {
	const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "[[Some Note]]" or "[[Some Note|Alias]]" -> "Some Note". Frontmatter
// wikilinks come through as plain strings, not resolved links.
function wikilinkTarget(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const match = raw.match(/\[\[([^\]|]+)/);
	return match ? match[1].trim() : raw.trim() || null;
}

function daysUntil(dateStr: string | undefined): string {
	if (!dateStr) return "";
	const deadline = new Date(dateStr);
	if (Number.isNaN(deadline.getTime())) return "";
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	deadline.setHours(0, 0, 0, 0);
	const days = Math.round((deadline.getTime() - today.getTime()) / 86400000);
	if (days < 0) return `${Math.abs(days)} days overdue`;
	if (days === 0) return "Due today";
	return `${days} days left`;
}

class LifeCompassSettingTab extends PluginSettingTab {
	plugin: LifeCompassPlugin;
	email = "";
	password = "";
	statusEl: HTMLElement;

	constructor(app: App, plugin: LifeCompassPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Life Compass — Sync" });
		containerEl.createEl("p", {
			text: "Connect a free Supabase project to sync your Wheel of Life ratings across devices in real time. Leave blank to use this device only. Your Goals/*.md notes stay the source of truth for everything else — this only syncs the interactive ratings.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Supabase project URL")
			.setDesc("From your Supabase project's Settings → API. Can be the same project you use for the habit tracker — just a different table.")
			.addText((text) =>
				text
					.setPlaceholder("https://xxxxx.supabase.co")
					.setValue(this.plugin.settings.supabaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Supabase anon public key")
			.setDesc("Also from Settings → API. Safe to store here — it's a public key, actual access is controlled by row-level security.")
			.addText((text) =>
				text
					.setPlaceholder("eyJ...")
					.setValue(this.plugin.settings.supabaseAnonKey)
					.onChange(async (value) => {
						this.plugin.settings.supabaseAnonKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Sign in" });
		this.statusEl = containerEl.createEl("p", { cls: "setting-item-description" });
		this.updateStatus();

		new Setting(containerEl).setName("Email").addText((text) => {
			text.inputEl.setAttribute("autocapitalize", "none");
			text.inputEl.setAttribute("autocorrect", "off");
			text.inputEl.setAttribute("spellcheck", "false");
			text.inputEl.type = "email";
			text.setPlaceholder("you@example.com").onChange((value) => {
				this.email = value.trim().toLowerCase();
			});
		});

		new Setting(containerEl).setName("Password").addText((text) => {
			text.inputEl.setAttribute("autocapitalize", "none");
			text.inputEl.setAttribute("autocorrect", "off");
			text.inputEl.setAttribute("spellcheck", "false");
			text.inputEl.type = "password";
			text.onChange((value) => {
				this.password = value;
			});
		});

		new Setting(containerEl)
			.addButton((btn) =>
				btn.setButtonText("Sign up").onClick(async () => {
					await this.plugin.signUp(this.email, this.password);
					this.updateStatus();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Sign in")
					.setCta()
					.onClick(async () => {
						await this.plugin.signIn(this.email, this.password);
						this.updateStatus();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Sign out").onClick(async () => {
					await this.plugin.signOut();
					this.updateStatus();
				})
			);
	}

	updateStatus() {
		const session = this.plugin.session;
		this.statusEl.setText(
			session ? `Signed in as ${session.user.email}. Syncing live.` : "Not signed in. Ratings are local-only on this device."
		);
	}
}

// Reads Goals/Vision.md's per-category prose so the wheel can show it
// alongside each rating without duplicating content — read-only here
// deliberately (see plan: editing prose happens in the note itself, so
// there's no risk of the plugin mangling manually-written text).
async function readVisionProse(app: App): Promise<Record<string, string>> {
	const file = app.vault.getAbstractFileByPath("Goals/Vision.md");
	const prose: Record<string, string> = {};
	if (!(file instanceof TFile)) return prose;
	const content = await app.vault.read(file);
	for (const cat of WHEEL_CATEGORIES) {
		const heading = cat.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = content.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m"));
		prose[cat.key] = match ? match[1].trim() : "";
	}
	return prose;
}

class LifeVisionBlock extends MarkdownRenderChild {
	plugin: LifeCompassPlugin;
	prose: Record<string, string> = {};

	constructor(containerEl: HTMLElement, plugin: LifeCompassPlugin) {
		super(containerEl);
		this.plugin = plugin;
	}

	onload() {
		this.plugin.registerVisionBlock(this);
		this.render();
	}

	onunload() {
		this.plugin.unregisterVisionBlock(this);
	}

	async render() {
		this.prose = await readVisionProse(this.plugin.app);
		this.draw();
	}

	draw() {
		const el = this.containerEl;
		el.empty();
		el.addClass("lc-wheel-root");

		const ratings = this.plugin.data.wheelRatings;
		el.appendChild(this.buildChart(ratings));

		const list = el.createDiv({ cls: "lc-wheel-list" });
		for (const cat of WHEEL_CATEGORIES) {
			const row = list.createDiv({ cls: "lc-wheel-row" });
			row.style.setProperty("--lc-cat-color", categoryColor(cat.key));
			row.createDiv({ text: cat.heading, cls: "lc-wheel-row-label" });

			const ratingRow = row.createDiv({ cls: "lc-wheel-rating-buttons" });
			const current = ratings[cat.key] ?? 0;
			for (let n = 1; n <= 10; n++) {
				const btn = ratingRow.createEl("button", { text: "" + n, cls: "lc-rating-btn" + (n <= current ? " lc-rating-btn-filled" : "") });
				btn.type = "button";
				btn.setAttr("aria-label", `Rate ${cat.heading} ${n} out of 10`);
				btn.onclick = async () => {
					this.plugin.data.wheelRatings[cat.key] = n;
					await this.plugin.persist();
					this.draw();
				};
			}

			const proseText = this.prose[cat.key];
			row.createDiv({
				text: proseText ? proseText : "(not yet defined — write it in Vision.md)",
				cls: "lc-wheel-row-prose" + (proseText ? "" : " lc-wheel-row-prose-empty"),
			});
		}
	}

	buildChart(ratings: Record<string, number>): SVGSVGElement {
		const size = 320;
		const center = size / 2;
		const maxRadius = size / 2 - 48;
		const n = WHEEL_CATEGORIES.length;
		const svgNs = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNs, "svg") as unknown as SVGSVGElement;
		svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
		svg.addClass("lc-wheel-chart");

		const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
		const pointAt = (i: number, radius: number) => {
			const a = angleFor(i);
			return [center + Math.cos(a) * radius, center + Math.sin(a) * radius];
		};

		// Grid rings at 2/4/6/8/10.
		for (let ring = 2; ring <= 10; ring += 2) {
			const r = (ring / 10) * maxRadius;
			const points = WHEEL_CATEGORIES.map((_, i) => pointAt(i, r).join(",")).join(" ");
			const poly = document.createElementNS(svgNs, "polygon");
			poly.setAttribute("points", points);
			poly.addClass("lc-wheel-grid-ring");
			svg.appendChild(poly);
		}

		// Axis lines + labels.
		WHEEL_CATEGORIES.forEach((cat, i) => {
			const [x, y] = pointAt(i, maxRadius);
			const line = document.createElementNS(svgNs, "line");
			line.setAttribute("x1", "" + center);
			line.setAttribute("y1", "" + center);
			line.setAttribute("x2", "" + x);
			line.setAttribute("y2", "" + y);
			line.addClass("lc-wheel-axis");
			svg.appendChild(line);

			const [lx, ly] = pointAt(i, maxRadius + 22);
			const label = document.createElementNS(svgNs, "text");
			label.setAttribute("x", "" + lx);
			label.setAttribute("y", "" + ly);
			label.setAttribute("text-anchor", "middle");
			label.setAttribute("dominant-baseline", "middle");
			label.addClass("lc-wheel-axis-label");
			label.textContent = cat.heading.split(" / ")[0];
			svg.appendChild(label);
		});

		// The filled data polygon itself.
		const dataPoints = WHEEL_CATEGORIES.map((cat, i) => pointAt(i, ((ratings[cat.key] ?? 0) / 10) * maxRadius).join(",")).join(" ");
		const dataPoly = document.createElementNS(svgNs, "polygon");
		dataPoly.setAttribute("points", dataPoints);
		dataPoly.addClass("lc-wheel-data-poly");
		svg.appendChild(dataPoly);

		WHEEL_CATEGORIES.forEach((cat, i) => {
			const value = ratings[cat.key] ?? 0;
			if (!value) return;
			const [x, y] = pointAt(i, (value / 10) * maxRadius);
			const dot = document.createElementNS(svgNs, "circle");
			dot.setAttribute("cx", "" + x);
			dot.setAttribute("cy", "" + y);
			dot.setAttribute("r", "4");
			dot.addClass("lc-wheel-data-dot");
			dot.style.setProperty("--lc-cat-color", categoryColor(cat.key));
			svg.appendChild(dot);
		});

		return svg;
	}
}

const CATEGORY_COLORS = ["#22c55e", "#3b82f6", "#ef4444", "#f97316", "#a855f7", "#eab308", "#ec4899"];
function categoryColor(key: string): string {
	const i = WHEEL_CATEGORIES.findIndex((c) => c.key === key);
	return CATEGORY_COLORS[i % CATEGORY_COLORS.length];
}

interface OutcomeFrontmatter {
	Status?: string;
	Deadline?: string;
	"Success Metric"?: string;
	"Vision Category"?: string;
}

class OutcomeCardsBlock extends MarkdownRenderChild {
	plugin: LifeCompassPlugin;

	constructor(containerEl: HTMLElement, plugin: LifeCompassPlugin) {
		super(containerEl);
		this.plugin = plugin;
	}

	onload() {
		this.render();
	}

	render() {
		const { app } = this.plugin;
		const el = this.containerEl;
		el.empty();
		el.addClass("lc-outcomes-root");

		const outcomeFiles = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Goals/Outcomes/"));
		const quarterFiles = app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith("Goals/Quarters/") && f.parent?.path === "Goals/Quarters");
		const habits = getHabitTrackerHabits(app);

		if (outcomeFiles.length === 0) {
			el.createDiv({ text: "No outcomes yet — add one under Goals/Outcomes/.", cls: "lc-outcomes-empty" });
			return;
		}

		const grid = el.createDiv({ cls: "lc-outcomes-grid" });
		for (const file of outcomeFiles) {
			const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as OutcomeFrontmatter;
			const card = grid.createDiv({ cls: "lc-outcome-card" });
			card.style.setProperty("--lc-outcome-color", categoryColor(slugifyCategory(fm["Vision Category"])));
			card.onclick = () => app.workspace.openLinkText(file.basename, "", false);

			const header = card.createDiv({ cls: "lc-outcome-header" });
			header.createDiv({ text: file.basename, cls: "lc-outcome-title" });
			const status = fm.Status ?? "active";
			header.createSpan({ text: status, cls: "lc-outcome-status lc-outcome-status-" + status });

			if (fm["Vision Category"]) {
				card.createDiv({ text: fm["Vision Category"], cls: "lc-outcome-category" });
			}
			if (fm["Success Metric"]) {
				card.createDiv({ text: fm["Success Metric"], cls: "lc-outcome-metric" });
			}
			if (fm.Deadline) {
				card.createDiv({ text: daysUntil(fm.Deadline), cls: "lc-outcome-deadline" });
			}

			// Find this outcome's current quarter(s) — any Quarter note whose
			// Outcome frontmatter wikilinks back to this file — then any
			// habit-tracker habits whose linkedGoal matches one of those
			// quarters (or the outcome itself directly).
			const linkedQuarterNames = quarterFiles
				.filter((qf) => {
					const qfm = app.metadataCache.getFileCache(qf)?.frontmatter as { Outcome?: string } | undefined;
					return wikilinkTarget(qfm?.Outcome) === file.basename;
				})
				.map((qf) => qf.basename);
			const matchNames = new Set([file.basename.toLowerCase(), ...linkedQuarterNames.map((n) => n.toLowerCase())]);
			const linkedHabits = (habits ?? []).filter((h) => h.linkedGoal && matchNames.has(h.linkedGoal.trim().toLowerCase()));

			if (linkedHabits.length) {
				const systemEl = card.createDiv({ cls: "lc-outcome-system" });
				systemEl.createDiv({ text: "System", cls: "lc-outcome-system-label" });
				for (const h of linkedHabits) {
					const row = systemEl.createDiv({ cls: "lc-outcome-habit-row" });
					const dot = row.createSpan({ cls: "lc-outcome-habit-dot" });
					dot.style.backgroundColor = h.color;
					row.createSpan({ text: h.name, cls: "lc-outcome-habit-name" });
					row.createSpan({ text: `🔥 ${getHabitStreak(app, h.id)}`, cls: "lc-outcome-habit-streak" });
				}
			} else if (habits) {
				card.createDiv({ text: "No linked habits yet", cls: "lc-outcome-system-empty" });
			}
		}
	}
}

function slugifyCategory(heading: string | undefined): string {
	const found = WHEEL_CATEGORIES.find((c) => c.heading === heading);
	return found ? found.key : "";
}

const SYNC_TABLE = "life_compass_data";

function mergeData(local: PluginData, remote: PluginData): PluginData {
	// Local wins per-key on conflict — same "union, local overrides" shape
	// as habit-tracker's mergeData, used once at initial connect.
	return { wheelRatings: { ...(remote.wheelRatings ?? {}), ...(local.wheelRatings ?? {}) } };
}

export default class LifeCompassPlugin extends Plugin {
	data: PluginData;
	settings: PluginSettings;
	supabase: SupabaseClient | null = null;
	session: Session | null = null;
	private realtimeChannel: RealtimeChannel | null = null;
	private visionBlocks: Set<LifeVisionBlock> = new Set();
	// Credentials the current `supabase` client was actually built from —
	// lets saveSettings() tell "the URL/key changed" apart from "an
	// unrelated setting changed while these two were already filled in",
	// so fixing a typo'd URL/key actually takes effect instead of the
	// original (possibly wrong) client silently sticking around.
	private initializedCredsKey = "";

	async onload() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings);
		this.data = { wheelRatings: saved?.wheelRatings ?? DEFAULT_DATA.wheelRatings };

		this.addSettingTab(new LifeCompassSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor("life-vision", (_source, el, ctx) => {
			const block = new LifeVisionBlock(el, this);
			ctx.addChild(block);
		});

		this.registerMarkdownCodeBlockProcessor("goals-outcomes", (_source, el, ctx) => {
			const block = new OutcomeCardsBlock(el, this);
			ctx.addChild(block);
		});

		if (this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
			await this.initSupabase();
		}
	}

	onunload() {
		if (this.realtimeChannel) this.supabase?.removeChannel(this.realtimeChannel);
	}

	async initSupabase() {
		this.supabase = createClient(this.settings.supabaseUrl, this.settings.supabaseAnonKey);
		this.initializedCredsKey = `${this.settings.supabaseUrl}|${this.settings.supabaseAnonKey}`;
		const { data } = await this.supabase.auth.getSession();
		if (data.session) {
			this.session = data.session;
			await this.connectRemote();
		}
	}

	async saveSettings() {
		await this.saveLocal();
		const credsKey = `${this.settings.supabaseUrl}|${this.settings.supabaseAnonKey}`;
		if (this.settings.supabaseUrl && this.settings.supabaseAnonKey && credsKey !== this.initializedCredsKey) {
			await this.initSupabase();
		}
	}

	async signUp(email: string, password: string) {
		if (!this.supabase) {
			new Notice("Enter the Supabase URL and anon key first.");
			return;
		}
		const { error } = await this.supabase.auth.signUp({ email, password });
		if (error) {
			new Notice(`Sign up failed: ${error.message}`);
		} else {
			new Notice("Account created. Check your email to confirm, then sign in.");
		}
	}

	async signIn(email: string, password: string) {
		if (!this.supabase) {
			new Notice("Enter the Supabase URL and anon key first.");
			return;
		}
		const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
		if (error) {
			new Notice(`Sign in failed: ${error.message}`);
			return;
		}
		this.session = data.session;
		new Notice("Signed in. Syncing…");
		await this.connectRemote();
	}

	async signOut() {
		if (this.realtimeChannel) {
			this.supabase?.removeChannel(this.realtimeChannel);
			this.realtimeChannel = null;
		}
		await this.supabase?.auth.signOut();
		this.session = null;
		new Notice("Signed out. This device is now local-only.");
	}

	async connectRemote() {
		if (!this.supabase || !this.session) return;

		const { data: row } = await this.supabase.from(SYNC_TABLE).select("data").eq("user_id", this.session.user.id).maybeSingle();

		if (row?.data) {
			this.data = mergeData(this.data, row.data as PluginData);
		}
		await this.persist();
		this.refreshVisionBlocks();
		this.subscribeRealtime();
	}

	subscribeRealtime() {
		if (!this.supabase || !this.session) return;
		if (this.realtimeChannel) this.supabase.removeChannel(this.realtimeChannel);

		this.realtimeChannel = this.supabase
			.channel("life_compass_data_changes")
			.on(
				"postgres_changes",
				{
					event: "UPDATE",
					schema: "public",
					table: SYNC_TABLE,
					filter: `user_id=eq.${this.session.user.id}`,
				},
				(payload) => {
					const incoming = payload.new.data as PluginData;
					this.data = { wheelRatings: incoming.wheelRatings ?? {} };
					this.saveLocal();
					this.refreshVisionBlocks();
				}
			)
			.subscribe();
	}

	async saveLocal() {
		await this.saveData({ settings: this.settings, wheelRatings: this.data.wheelRatings });
	}

	async persist() {
		await this.saveLocal();
		if (this.supabase && this.session) {
			const { error } = await this.supabase.from(SYNC_TABLE).upsert({
				user_id: this.session.user.id,
				data: this.data,
				updated_at: new Date().toISOString(),
			});
			if (error) {
				new Notice(`Sync failed, saved locally only: ${error.message}`);
			}
		}
	}

	registerVisionBlock(block: LifeVisionBlock) {
		this.visionBlocks.add(block);
	}

	unregisterVisionBlock(block: LifeVisionBlock) {
		this.visionBlocks.delete(block);
	}

	refreshVisionBlocks() {
		for (const block of this.visionBlocks) block.draw();
	}
}
