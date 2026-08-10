import {
	Plugin,
	PluginSettingTab,
	ItemView,
	WorkspaceLeaf,
	Modal,
	MarkdownRenderChild,
	App,
	Setting,
	Notice,
	TFile,
	TFolder,
} from "obsidian";
import { createClient, SupabaseClient, Session, RealtimeChannel } from "@supabase/supabase-js";

// The seven Wheel of Life categories.
interface WheelCategory {
	key: string;
	label: string;
}

const WHEEL_CATEGORIES: WheelCategory[] = [
	{ key: "career-business", label: "Career / Business" },
	{ key: "money", label: "Money" },
	{ key: "health", label: "Health" },
	{ key: "relationships", label: "Relationships" },
	{ key: "lifestyle", label: "Lifestyle" },
	{ key: "personal-growth", label: "Personal Growth" },
	{ key: "contribution", label: "Contribution" },
];

const CATEGORY_COLORS = ["#22c55e", "#3b82f6", "#ef4444", "#f97316", "#a855f7", "#eab308", "#ec4899"];
function categoryColor(key: string): string {
	const i = WHEEL_CATEGORIES.findIndex((c) => c.key === key);
	return CATEGORY_COLORS[i % CATEGORY_COLORS.length];
}
function categoryKeyForLabel(label: string | undefined): string {
	const found = WHEEL_CATEGORIES.find((c) => c.label === label);
	return found ? found.key : WHEEL_CATEGORIES[0].key;
}

// ---- Data model — Life Compass owns all of this itself now (no Goals/*.md
// dependency); only synced via Supabase like habit-tracker. ----

interface VisionCategoryData {
	rating: number; // 0 = unrated, 1-10 otherwise
	prose: string;
}

type GoalStatus = "active" | "done" | "missed";

interface Outcome {
	id: string;
	name: string;
	visionCategory: string; // WHEEL_CATEGORIES key
	deadline: string; // YYYY-MM-DD
	status: GoalStatus;
	successMetric: string;
	why: string;
	baseline?: string;
	obstacles?: string;
	progress: number; // 0-100, manually set
	createdAt: string;
	updatedAt: string;
}

interface MilestoneItem {
	text: string;
	done: boolean;
}

interface MonthlyMilestone {
	month: string;
	title: string;
	items: MilestoneItem[];
}

interface CheckinField {
	key: string;
	label: string;
	type: "number" | "text";
}

interface Quarter {
	id: string; // e.g. "2026-Q3"
	outcomeId: string;
	deadline: string;
	status: GoalStatus;
	successMetric: string;
	priority: string; // the one Wildly Important Goal
	why: string;
	notes?: string; // catches anything that doesn't fit the standard sections
	milestones: MonthlyMilestone[];
	weeklyCommitments: string;
	dailyActionsPrompt: string;
	obstacles: string;
	checkinFields: CheckinField[];
	checkins: Record<string, Record<string, string | number>>; // date -> field values
	createdAt: string;
	updatedAt: string;
}

interface PluginData {
	vision: Record<string, VisionCategoryData>;
	outcomes: Outcome[];
	quarters: Quarter[];
	currentQuarterId: string | null;
}

const DEFAULT_DATA: PluginData = { vision: {}, outcomes: [], quarters: [], currentQuarterId: null };

interface PluginSettings {
	supabaseUrl: string;
	supabaseAnonKey: string;
}

const DEFAULT_SETTINGS: PluginSettings = { supabaseUrl: "", supabaseAnonKey: "" };

function uid(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "") || "item"
	);
}

function todayStr(): string {
	return formatDate(new Date());
}

function formatDate(d: Date): string {
	const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// Shared by both the Quarter tab's Check-ins section and the Daily Note
// embed — was previously copy-pasted in both places, risking drift.
function renderCheckinTodayForm(container: HTMLElement, plugin: LifeCompassPlugin, quarter: Quarter, onSaved: () => void) {
	if (quarter.checkinFields.length === 0) {
		container.createDiv({ text: "No check-in fields defined yet — add some by editing this quarter.", cls: "lc-outcomes-empty" });
		return;
	}
	const today = todayStr();
	const todayValues = quarter.checkins[today] ?? {};
	const form = container.createDiv({ cls: "lc-checkin-form" });
	const inputs: Record<string, HTMLInputElement> = {};
	for (const field of quarter.checkinFields) {
		const row = form.createDiv({ cls: "lc-checkin-field-row" });
		row.createSpan({ text: field.label, cls: "lc-checkin-field-label" });
		const input = row.createEl("input", { cls: "lc-inline-input" });
		input.type = field.type === "number" ? "number" : "text";
		input.value = todayValues[field.key] !== undefined ? "" + todayValues[field.key] : "";
		input.setAttr("aria-label", field.label);
		inputs[field.key] = input;
	}
	const saveBtn = form.createEl("button", { text: `Save today (${today})`, cls: "mod-cta" });
	saveBtn.type = "button";
	saveBtn.onclick = async () => {
		const entry: Record<string, string | number> = {};
		for (const field of quarter.checkinFields) {
			const raw = inputs[field.key].value;
			entry[field.key] = field.type === "number" ? Number(raw) || 0 : raw;
		}
		quarter.checkins[today] = entry;
		await plugin.persist();
		new Notice("Check-in saved.");
		onSaved();
	};
}

// A compact heatmap for the current quarter's first numeric check-in
// field — one cell per day from the quarter's earliest check-in (or
// today, whichever is earlier) through today, colored by intensity
// relative to the highest value logged. Restores the visual the old
// Tracker-plugin heatmap gave before the markdown-based system was
// removed.
function buildCheckinHeatmap(quarter: Quarter): HTMLElement | null {
	const numericField = quarter.checkinFields.find((f) => f.type === "number");
	if (!numericField) return null;
	const dates = Object.keys(quarter.checkins).sort();
	if (dates.length === 0) return null;

	const maxVal = Math.max(1, ...dates.map((d) => Number(quarter.checkins[d][numericField.key]) || 0));
	const start = new Date(dates[0]);
	const end = new Date();
	const wrap = document.createElement("div");
	wrap.addClass("lc-heatmap-wrap");
	wrap.createDiv({ text: `${numericField.label} — daily`, cls: "lc-field-label" });
	const grid = wrap.createDiv({ cls: "lc-heatmap-grid" });

	for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
		const dateStr = formatDate(d);
		const value = Number(quarter.checkins[dateStr]?.[numericField.key]) || 0;
		const cell = grid.createDiv({ cls: "lc-heatmap-cell" });
		cell.setAttr("aria-label", `${dateStr}: ${value}`);
		cell.title = `${dateStr}: ${value}`;
		if (value > 0) {
			const intensity = Math.min(1, value / maxVal);
			cell.style.opacity = `${0.25 + intensity * 0.75}`;
			cell.addClass("lc-heatmap-cell-filled");
		}
	}
	return wrap;
}

// ---- Cross-plugin interop with habit-tracker (unrelated data store, read
// directly — see CLAUDE.md's Life Compass section). ----

interface LinkedHabitLite {
	id: string;
	name: string;
	color: string;
	linkedGoal?: string;
}

function getHabitTrackerHabits(app: App): LinkedHabitLite[] | null {
	const anyApp = app as unknown as { plugins: { plugins: Record<string, { data?: { habits?: LinkedHabitLite[] } }> } };
	return anyApp.plugins?.plugins?.["habit-tracker"]?.data?.habits ?? null;
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

// ---- Migration from the old Goals/*.md system (one-time, explicit) ----

function extractSection(content: string, heading: string, level: "##" | "###" = "##"): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${level} ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n${level} |$)`, "m");
	const match = content.match(re);
	return match ? match[1].trim() : "";
}

function extractAllH2(content: string): { heading: string; body: string }[] {
	const sections: { heading: string; body: string }[] = [];
	const re = /^## (.+)\n([\s\S]*?)(?=\n## |$)/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content))) {
		sections.push({ heading: m[1].trim(), body: m[2].trim() });
	}
	return sections;
}

// "[[Some Note]]" or "[[Some Note|Alias]]" -> "Some Note".
function wikilinkTarget(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const match = raw.match(/\[\[([^\]|]+)/);
	return match ? match[1].trim() : raw.trim() || null;
}

function isPlaceholder(text: string): boolean {
	// "(not yet defined ...)" / "(not yet captured.)" style placeholders
	// used throughout the old Goals/ notes — don't migrate these as if
	// they were real content.
	return !text || /^\*?\(.*not yet.*\)\*?$/i.test(text.trim());
}

interface MigrationResult {
	vision: Record<string, VisionCategoryData>;
	outcomes: Outcome[];
	quarters: Quarter[];
	currentQuarterId: string | null;
	summary: string;
}

async function importFromGoalsNotes(app: App, existingVision: Record<string, VisionCategoryData>): Promise<MigrationResult | null> {
	const goalsFolder = app.vault.getAbstractFileByPath("Goals");
	if (!(goalsFolder instanceof TFolder)) return null;

	// Vision
	const vision: Record<string, VisionCategoryData> = {};
	const visionFile = app.vault.getAbstractFileByPath("Goals/Vision.md");
	if (visionFile instanceof TFile) {
		const content = await app.vault.read(visionFile);
		for (const cat of WHEEL_CATEGORIES) {
			const body = extractSection(content, cat.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
			vision[cat.key] = {
				rating: existingVision[cat.key]?.rating ?? 0,
				prose: isPlaceholder(body) ? "" : body,
			};
		}
	}

	const warnings: string[] = [];

	// Outcomes
	const outcomes: Outcome[] = [];
	const outcomeNameToId = new Map<string, string>();
	const outcomeFiles = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Goals/Outcomes/"));
	for (const file of outcomeFiles) {
		const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, string>;
		const content = await app.vault.read(file);
		const why = extractSection(content, "Why");
		const baseline = extractSection(content, "Baseline");
		const obstacles = extractSection(content, "Obstacles");
		const id = uid(slugify(file.basename));
		outcomeNameToId.set(file.basename, id);
		if (fm["Vision Category"] && !WHEEL_CATEGORIES.some((c) => c.label === fm["Vision Category"])) {
			warnings.push(`"${file.basename}": Vision Category "${fm["Vision Category"]}" didn't match a known category — defaulted to "${WHEEL_CATEGORIES[0].label}", check it.`);
		}
		outcomes.push({
			id,
			name: file.basename,
			visionCategory: categoryKeyForLabel(fm["Vision Category"]),
			deadline: fm.Deadline ?? "",
			status: (fm.Status as GoalStatus) ?? "active",
			successMetric: fm["Success Metric"] ?? "",
			why: isPlaceholder(why) ? "" : why,
			baseline: isPlaceholder(baseline) ? undefined : baseline,
			obstacles: isPlaceholder(obstacles) ? undefined : obstacles,
			progress: 0,
			createdAt: fm.Created ?? todayStr(),
			updatedAt: fm["Last Updated"] ?? todayStr(),
		});
	}

	// Quarters (top-level files directly under Goals/Quarters/, not the
	// nested Check-ins/ subfolders)
	const quarters: Quarter[] = [];
	const quarterFiles = app.vault
		.getMarkdownFiles()
		.filter((f) => f.path.startsWith("Goals/Quarters/") && f.parent?.path === "Goals/Quarters");
	const knownH2 = new Set(["Priority", "Why", "Monthly Milestones", "System", "Obstacles", "Plan B", "Check-ins", "Sources"]);
	let totalCheckins = 0;

	for (const file of quarterFiles) {
		const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, string>;
		const content = await app.vault.read(file);
		const outcomeName = wikilinkTarget(fm.Outcome);
		const matchedOutcomeId = outcomeName ? outcomeNameToId.get(outcomeName) : undefined;
		if (outcomeName && !matchedOutcomeId) {
			warnings.push(`"${file.basename}": Outcome link "${outcomeName}" didn't match any imported outcome — defaulted to "${outcomes[0]?.name ?? "(none)"}", check it.`);
		}
		const outcomeId = matchedOutcomeId ?? outcomes[0]?.id ?? "";

		const priority = extractSection(content, "Priority");
		const why = extractSection(content, "Why");
		const obstacles = extractSection(content, "Obstacles");
		const systemBody = extractSection(content, "System");
		const weeklyCommitments = extractSection(systemBody, "Weekly Commitments", "###");
		const dailyActionsPrompt = extractSection(systemBody, "Daily Actions", "###");

		const extraSections = extractAllH2(content).filter((s) => !knownH2.has(s.heading));
		const notes = extraSections.length ? extraSections.map((s) => `${s.heading}\n${s.body}`).join("\n\n") : undefined;

		// Monthly Milestones: "### <Month> — <Title>" headings, each
		// followed by a numbered list.
		const milestonesBody = extractSection(content, "Monthly Milestones");
		const milestones: MonthlyMilestone[] = [];
		const groupRe = /^### (.+)\n([\s\S]*?)(?=\n### |$)/gm;
		let gm: RegExpExecArray | null;
		while ((gm = groupRe.exec(milestonesBody))) {
			const heading = gm[1].trim();
			const [month, title] = heading.includes(" — ") ? heading.split(" — ").map((s) => s.trim()) : [heading, ""];
			const items: MilestoneItem[] = gm[2]
				.split("\n")
				.map((line) => line.replace(/^\s*\d+\.\s*/, "").trim())
				.filter(Boolean)
				.map((text) => ({ text, done: false }));
			milestones.push({ month, title, items });
		}

		// Check-ins: Goals/Quarters/<id>/Check-ins/YYYY-MM-DD.md, each
		// containing Dataview inline fields like [emails:: 320] [phase:: sending]
		const checkins: Record<string, Record<string, string | number>> = {};
		const fieldTypeVotes = new Map<string, { numeric: number; total: number }>();
		const checkinFolder = app.vault.getAbstractFileByPath(`Goals/Quarters/${file.basename}/Check-ins`);
		if (checkinFolder instanceof TFolder) {
			for (const child of checkinFolder.children) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const dayContent = await app.vault.read(child);
				const entry: Record<string, string | number> = {};
				const fieldRe = /\[(\w+)::\s*([^\]]+)\]/g;
				let fm2: RegExpExecArray | null;
				while ((fm2 = fieldRe.exec(dayContent))) {
					const key = fm2[1];
					const raw = fm2[2].trim();
					const num = Number(raw);
					const isNum = raw !== "" && !Number.isNaN(num);
					entry[key] = isNum ? num : raw;
					const votes = fieldTypeVotes.get(key) ?? { numeric: 0, total: 0 };
					votes.total++;
					if (isNum) votes.numeric++;
					fieldTypeVotes.set(key, votes);
				}
				if (Object.keys(entry).length) {
					checkins[child.basename] = entry;
					totalCheckins++;
				}
			}
		}
		const checkinFields: CheckinField[] = Array.from(fieldTypeVotes.entries()).map(([key, votes]) => ({
			key,
			label: key,
			type: votes.numeric === votes.total ? "number" : "text",
		}));

		quarters.push({
			id: file.basename,
			outcomeId,
			deadline: fm.Deadline ?? "",
			status: (fm.Status as GoalStatus) ?? "active",
			successMetric: fm["Success Metric"] ?? "",
			priority: isPlaceholder(priority) ? "" : priority,
			why: isPlaceholder(why) ? "" : why,
			notes,
			milestones,
			weeklyCommitments: isPlaceholder(weeklyCommitments) ? "" : weeklyCommitments,
			dailyActionsPrompt: isPlaceholder(dailyActionsPrompt) ? "" : dailyActionsPrompt,
			obstacles: isPlaceholder(obstacles) ? "" : obstacles,
			checkinFields,
			checkins,
			createdAt: fm.Created ?? todayStr(),
			updatedAt: fm["Last Updated"] ?? todayStr(),
		});
	}

	const activeQuarters = quarters.filter((q) => q.status === "active");
	const currentQuarterId = activeQuarters.length === 1 ? activeQuarters[0].id : quarters[0]?.id ?? null;

	let summary = `Imported ${outcomes.length} outcome${outcomes.length === 1 ? "" : "s"}, ${quarters.length} quarter${
		quarters.length === 1 ? "" : "s"
	}, ${totalCheckins} check-in day${totalCheckins === 1 ? "" : "s"}.`;
	if (warnings.length) {
		summary += `\n\n⚠️ ${warnings.length} thing${warnings.length === 1 ? "" : "s"} to double-check after import:\n` + warnings.map((w) => `• ${w}`).join("\n");
	}

	return { vision, outcomes, quarters, currentQuarterId, summary };
}

class ConfirmMigrationModal extends Modal {
	summary: string;
	onConfirm: () => void;

	constructor(app: App, summary: string, onConfirm: () => void) {
		super(app);
		this.summary = summary;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("lc-modal");
		contentEl.createEl("h3", { text: "Import complete" });
		contentEl.createEl("p", { text: this.summary, cls: "lc-modal-summary" });
		contentEl.createEl("p", {
			text: "Life Compass now owns this data (synced via Supabase). Move the old Goals/ notes to trash? This uses your system/Obsidian trash, not permanent deletion.",
			cls: "setting-item-description",
		});
		const footer = contentEl.createDiv({ cls: "lc-modal-footer" });
		const keepBtn = footer.createEl("button", { text: "Keep the notes for now" });
		keepBtn.type = "button";
		keepBtn.onclick = () => this.close();
		const trashBtn = footer.createEl("button", { text: "Move Goals/ notes to trash", cls: "mod-warning" });
		trashBtn.type = "button";
		trashBtn.onclick = () => {
			this.onConfirm();
			this.close();
		};
	}
}

// ---- Settings tab ----

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
			text: "Connect a free Supabase project to sync your Vision, Outcomes, and Quarter across devices in real time. Leave blank to use this device only.",
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

		containerEl.createEl("h3", { text: "Migrate from the old Goals/ notes" });
		containerEl.createEl("p", {
			text: "One-time import: reads Goals/Vision.md, Goals/Outcomes/*.md, and Goals/Quarters/*.md (including daily Check-ins) into Life Compass, then offers to move those notes to trash.",
			cls: "setting-item-description",
		});
		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Import from Goals/ notes…").onClick(async () => {
				await this.plugin.runMigration();
			})
		);

		containerEl.createEl("h3", { text: "Backup" });
		containerEl.createEl("p", {
			text: "Now that Vision/Outcomes/Quarters aren't stored as notes, the only durable copy besides Supabase is this device's local plugin data. Export a snapshot into the vault (backed up the same way the rest of your notes are) as a safety net.",
			cls: "setting-item-description",
		});
		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Export data as JSON…").onClick(async () => {
				await this.plugin.exportData();
			})
		);
	}

	updateStatus() {
		const session = this.plugin.session;
		this.statusEl.setText(
			session ? `Signed in as ${session.user.email}. Syncing live.` : "Not signed in. Data is local-only on this device."
		);
	}
}

// ---- The main view ----

const VIEW_TYPE = "life-compass-view";
type Tab = "overview" | "vision" | "outcomes" | "quarter";

class LifeCompassView extends ItemView {
	plugin: LifeCompassPlugin;
	activeTab: Tab = "overview";

	constructor(leaf: WorkspaceLeaf, plugin: LifeCompassPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return "Life Compass";
	}
	getIcon() {
		return "compass";
	}

	async onOpen() {
		this.render();
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("lc-view-root");

		const tabRow = root.createDiv({ cls: "lc-tab-row" });
		const tabs: { id: Tab; label: string }[] = [
			{ id: "overview", label: "🏠 Overview" },
			{ id: "vision", label: "🎯 Vision" },
			{ id: "outcomes", label: "🚀 Outcomes" },
			{ id: "quarter", label: "📅 Quarter" },
		];
		for (const tab of tabs) {
			const btn = tabRow.createEl("button", {
				text: tab.label,
				cls: "lc-tab-btn" + (this.activeTab === tab.id ? " lc-tab-btn-active" : ""),
			});
			btn.type = "button";
			btn.onclick = () => {
				this.activeTab = tab.id;
				this.render();
			};
		}

		const body = root.createDiv({ cls: "lc-tab-body" });
		if (this.activeTab === "overview") this.renderOverview(body);
		else if (this.activeTab === "vision") this.renderVision(body);
		else if (this.activeTab === "outcomes") this.renderOutcomes(body);
		else this.renderQuarter(body);
	}

	// ---- Vision tab ----
	// ---- Overview tab: a glance across all three tabs, since previously
	// there was no way to see wheel + quarter + outcomes at once. ----
	renderOverview(body: HTMLElement) {
		body.addClass("lc-overview-root");

		const ratings = WHEEL_CATEGORIES.map((c) => this.plugin.data.vision[c.key]?.rating ?? 0).filter((r) => r > 0);
		const avgRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—";
		const visionCard = body.createDiv({ cls: "lc-overview-card" });
		visionCard.createDiv({ text: "🎯 Vision", cls: "lc-field-label" });
		visionCard.createDiv({
			text: ratings.length ? `Average satisfaction: ${avgRating} / 10 across ${ratings.length} rated categories` : "No categories rated yet.",
			cls: "lc-outcome-metric",
		});

		const current = this.plugin.data.quarters.find((q) => q.id === this.plugin.data.currentQuarterId);
		const quarterCard = body.createDiv({ cls: "lc-overview-card" });
		quarterCard.createDiv({ text: "📅 Current Quarter", cls: "lc-field-label" });
		if (current) {
			quarterCard.createDiv({ text: current.id, cls: "lc-outcome-title" });
			if (current.priority) quarterCard.createDiv({ text: current.priority, cls: "lc-outcome-metric" });
			if (current.deadline) quarterCard.createDiv({ text: daysUntil(current.deadline), cls: "lc-outcome-deadline" });
		} else {
			quarterCard.createDiv({ text: "No active quarter.", cls: "lc-outcomes-empty" });
		}

		const outcomes = this.plugin.data.outcomes;
		const outcomesCard = body.createDiv({ cls: "lc-overview-card" });
		outcomesCard.createDiv({ text: "🚀 Outcomes", cls: "lc-field-label" });
		const active = outcomes.filter((o) => o.status === "active").length;
		const done = outcomes.filter((o) => o.status === "done").length;
		outcomesCard.createDiv({ text: `${active} active, ${done} done, ${outcomes.length} total`, cls: "lc-outcome-metric" });
		for (const o of outcomes.filter((o) => o.status === "active")) {
			const row = outcomesCard.createDiv({ cls: "lc-overview-outcome-row" });
			row.createSpan({ text: o.name, cls: "lc-outcome-habit-name" });
			const progressWrap = row.createDiv({ cls: "lc-progress-wrap lc-progress-wrap-compact" });
			const progressTrack = progressWrap.createDiv({ cls: "lc-progress-track" });
			const bar = progressTrack.createDiv({ cls: "lc-progress-bar" });
			bar.style.width = `${Math.max(0, Math.min(100, o.progress ?? 0))}%`;
			progressWrap.createSpan({ text: `${o.progress ?? 0}%`, cls: "lc-progress-label" });
		}
	}

	renderVision(body: HTMLElement) {
		body.addClass("lc-wheel-root");
		// A rating click only needs to update the chart + that row's button
		// fill state — not tear down the whole tab (which would wipe
		// whatever's typed but not yet blurred in any of the 7 prose
		// textareas below).
		const chartHolder = body.createDiv();
		const redrawChart = () => {
			chartHolder.empty();
			chartHolder.appendChild(this.buildChart());
		};
		redrawChart();

		const list = body.createDiv({ cls: "lc-wheel-list" });
		for (const cat of WHEEL_CATEGORIES) {
			const row = list.createDiv({ cls: "lc-wheel-row" });
			row.style.setProperty("--lc-cat-color", categoryColor(cat.key));
			row.createDiv({ text: cat.label, cls: "lc-wheel-row-label" });

			const ratingRow = row.createDiv({ cls: "lc-wheel-rating-buttons" });
			const current = this.plugin.data.vision[cat.key]?.rating ?? 0;
			const buttons: HTMLButtonElement[] = [];
			for (let n = 1; n <= 10; n++) {
				const btn = ratingRow.createEl("button", { text: "" + n, cls: "lc-rating-btn" + (n <= current ? " lc-rating-btn-filled" : "") });
				btn.type = "button";
				btn.setAttr("aria-label", `Rate ${cat.label} ${n} out of 10`);
				buttons.push(btn);
				btn.onclick = async () => {
					this.plugin.data.vision[cat.key].rating = n;
					await this.plugin.persist();
					buttons.forEach((b, i) => b.toggleClass("lc-rating-btn-filled", i + 1 <= n));
					redrawChart();
				};
			}

			const prose = row.createEl("textarea", { cls: "lc-textarea lc-wheel-row-prose-input" });
			prose.rows = 3;
			prose.placeholder = "What would this category look like if everything was exactly how you wanted it?";
			prose.value = this.plugin.data.vision[cat.key]?.prose ?? "";
			prose.setAttr("aria-label", `${cat.label} vision`);
			prose.onblur = async () => {
				this.plugin.data.vision[cat.key].prose = prose.value;
				await this.plugin.persist();
			};
		}
	}

	buildChart(): SVGSVGElement {
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

		for (let ring = 2; ring <= 10; ring += 2) {
			const r = (ring / 10) * maxRadius;
			const points = WHEEL_CATEGORIES.map((_, i) => pointAt(i, r).join(",")).join(" ");
			const poly = document.createElementNS(svgNs, "polygon");
			poly.setAttribute("points", points);
			poly.addClass("lc-wheel-grid-ring");
			svg.appendChild(poly);
		}

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
			label.textContent = cat.label.split(" / ")[0];
			svg.appendChild(label);
		});

		const dataPoints = WHEEL_CATEGORIES.map((cat, i) => pointAt(i, ((this.plugin.data.vision[cat.key]?.rating ?? 0) / 10) * maxRadius).join(","))
			.join(" ");
		const dataPoly = document.createElementNS(svgNs, "polygon");
		dataPoly.setAttribute("points", dataPoints);
		dataPoly.addClass("lc-wheel-data-poly");
		svg.appendChild(dataPoly);

		WHEEL_CATEGORIES.forEach((cat, i) => {
			const value = this.plugin.data.vision[cat.key]?.rating ?? 0;
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

	// ---- Outcomes tab ----
	renderOutcomes(body: HTMLElement) {
		body.addClass("lc-outcomes-root");

		const addBtn = body.createEl("button", { text: "+ Add Outcome", cls: "lc-add-btn" });
		addBtn.type = "button";
		addBtn.onclick = () => new OutcomeFormModal(this.plugin, null, () => this.render()).open();

		if (this.plugin.data.outcomes.length === 0) {
			body.createDiv({ text: "No outcomes yet — add your first one above.", cls: "lc-outcomes-empty" });
			return;
		}

		const habits = getHabitTrackerHabits(this.plugin.app);
		const grid = body.createDiv({ cls: "lc-outcomes-grid" });
		for (const outcome of this.plugin.data.outcomes) {
			const card = grid.createDiv({ cls: "lc-outcome-card" });
			card.style.setProperty("--lc-outcome-color", categoryColor(outcome.visionCategory));

			const header = card.createDiv({ cls: "lc-outcome-header" });
			header.createDiv({ text: outcome.name, cls: "lc-outcome-title" });
			header.createSpan({ text: outcome.status, cls: "lc-outcome-status lc-outcome-status-" + outcome.status });

			const catLabel = WHEEL_CATEGORIES.find((c) => c.key === outcome.visionCategory)?.label;
			if (catLabel) card.createDiv({ text: catLabel, cls: "lc-outcome-category" });
			if (outcome.successMetric) card.createDiv({ text: outcome.successMetric, cls: "lc-outcome-metric" });
			if (outcome.deadline) card.createDiv({ text: daysUntil(outcome.deadline), cls: "lc-outcome-deadline" });

			const progressWrap = card.createDiv({ cls: "lc-progress-wrap" });
			const progressTrack = progressWrap.createDiv({ cls: "lc-progress-track" });
			const progressBar = progressTrack.createDiv({ cls: "lc-progress-bar" });
			progressBar.style.width = `${Math.max(0, Math.min(100, outcome.progress ?? 0))}%`;
			progressWrap.createSpan({ text: `${outcome.progress ?? 0}%`, cls: "lc-progress-label" });

			const linkedQuarterIds = this.plugin.data.quarters.filter((q) => q.outcomeId === outcome.id).map((q) => q.id.toLowerCase());
			const matchNames = new Set([outcome.name.toLowerCase(), ...linkedQuarterIds]);
			const linkedHabits = (habits ?? []).filter((h) => h.linkedGoal && matchNames.has(h.linkedGoal.trim().toLowerCase()));

			if (linkedHabits.length) {
				const systemEl = card.createDiv({ cls: "lc-outcome-system" });
				systemEl.createDiv({ text: "System", cls: "lc-outcome-system-label" });
				for (const h of linkedHabits) {
					const row = systemEl.createDiv({ cls: "lc-outcome-habit-row" });
					const dot = row.createSpan({ cls: "lc-outcome-habit-dot" });
					dot.style.backgroundColor = h.color;
					row.createSpan({ text: h.name, cls: "lc-outcome-habit-name" });
					row.createSpan({ text: `🔥 ${getHabitStreak(this.plugin.app, h.id)}`, cls: "lc-outcome-habit-streak" });
				}
			} else if (habits) {
				card.createDiv({ text: "No linked habits yet", cls: "lc-outcome-system-empty" });
			}

			const actions = card.createDiv({ cls: "lc-outcome-actions" });
			const editBtn = actions.createEl("button", { text: "✏️", cls: "lc-icon-btn" });
			editBtn.type = "button";
			editBtn.setAttr("aria-label", "Edit outcome");
			editBtn.onclick = (e) => {
				e.stopPropagation();
				new OutcomeFormModal(this.plugin, outcome, () => this.render()).open();
			};
			const delBtn = actions.createEl("button", { text: "🗑", cls: "lc-icon-btn" });
			delBtn.type = "button";
			delBtn.setAttr("aria-label", "Delete outcome");
			delBtn.onclick = (e) => {
				e.stopPropagation();
				new ConfirmDeleteModal(this.plugin.app, outcome.name, async () => {
					this.plugin.data.outcomes = this.plugin.data.outcomes.filter((o) => o.id !== outcome.id);
					await this.plugin.persist();
					this.render();
				}).open();
			};
		}
	}

	// ---- Quarter tab ----
	renderQuarter(body: HTMLElement) {
		body.addClass("lc-quarter-root");
		const current = this.plugin.data.quarters.find((q) => q.id === this.plugin.data.currentQuarterId) ?? null;

		if (!current) {
			body.createDiv({ text: "No active quarter yet.", cls: "lc-outcomes-empty" });
			const startBtn = body.createEl("button", { text: "+ Start a Quarter", cls: "lc-add-btn" });
			startBtn.type = "button";
			startBtn.onclick = () => new QuarterFormModal(this.plugin, null, () => this.render()).open();
			this.renderPastQuarters(body, null);
			return;
		}

		const outcome = this.plugin.data.outcomes.find((o) => o.id === current.outcomeId);
		const header = body.createDiv({ cls: "lc-quarter-header" });
		header.createDiv({ text: current.id, cls: "lc-quarter-id" });
		header.createSpan({ text: current.status, cls: "lc-outcome-status lc-outcome-status-" + current.status });
		const editBtn = header.createEl("button", { text: "✏️ Edit", cls: "lc-icon-btn" });
		editBtn.type = "button";
		editBtn.setAttr("aria-label", "Edit quarter");
		editBtn.onclick = () => new QuarterFormModal(this.plugin, current, () => this.render()).open();
		const delBtn = header.createEl("button", { text: "🗑", cls: "lc-icon-btn" });
		delBtn.type = "button";
		delBtn.setAttr("aria-label", "Delete quarter");
		delBtn.onclick = () => {
			new ConfirmDeleteModal(this.plugin.app, current.id, async () => {
				this.plugin.data.quarters = this.plugin.data.quarters.filter((q) => q.id !== current.id);
				if (this.plugin.data.currentQuarterId === current.id) this.plugin.data.currentQuarterId = null;
				await this.plugin.persist();
				this.render();
			}).open();
		};

		if (outcome) body.createDiv({ text: `Ladders up to: ${outcome.name}`, cls: "lc-outcome-category" });
		if (current.successMetric) body.createDiv({ text: current.successMetric, cls: "lc-outcome-metric" });
		if (current.deadline) body.createDiv({ text: daysUntil(current.deadline), cls: "lc-outcome-deadline" });

		this.renderTextSection(body, "Priority — the ONE Wildly Important Goal", current.priority, async (v) => {
			current.priority = v;
			await this.plugin.persist();
		});
		this.renderTextSection(body, "Why", current.why, async (v) => {
			current.why = v;
			await this.plugin.persist();
		});
		if (current.notes) {
			this.renderTextSection(body, "Notes", current.notes, async (v) => {
				current.notes = v;
				await this.plugin.persist();
			});
		}

		const milestonesWrap = body.createDiv();
		const redrawMilestones = () => {
			milestonesWrap.empty();
			this.renderMilestonesInto(milestonesWrap, current, redrawMilestones);
		};
		redrawMilestones();

		const systemSection = body.createDiv({ cls: "lc-quarter-section" });
		systemSection.createEl("h4", { text: "System" });
		this.renderTextSection(systemSection, "Weekly Commitments", current.weeklyCommitments, async (v) => {
			current.weeklyCommitments = v;
			await this.plugin.persist();
		});
		this.renderTextSection(systemSection, "Daily Actions", current.dailyActionsPrompt, async (v) => {
			current.dailyActionsPrompt = v;
			await this.plugin.persist();
		});

		this.renderTextSection(body, "Obstacles", current.obstacles, async (v) => {
			current.obstacles = v;
			await this.plugin.persist();
		});

		const checkinsWrap = body.createDiv();
		const redrawCheckins = () => {
			checkinsWrap.empty();
			this.renderCheckinsInto(checkinsWrap, current, redrawCheckins);
		};
		redrawCheckins();

		const closeBtn = body.createEl("button", { text: "Start new quarter", cls: "lc-add-btn" });
		closeBtn.type = "button";
		closeBtn.onclick = () => {
			// Don't mark the current quarter done until the NEW quarter is
			// actually saved — closing this form via Escape/click-outside
			// used to leave the old quarter marked done with nothing to
			// replace it.
			new QuarterFormModal(this.plugin, null, () => {
				if (current.status === "active") {
					current.status = "done";
					current.updatedAt = todayStr();
					this.plugin.persist();
				}
				new Notice(`🎉 "${current.id}" closed out. On to the next one.`);
				this.render();
			}).open();
		};

		this.renderPastQuarters(body, current.id);
	}

	renderTextSection(container: HTMLElement, label: string, value: string, onSave: (v: string) => Promise<void>) {
		const section = container.createDiv({ cls: "lc-quarter-section" });
		section.createEl("div", { text: label, cls: "lc-field-label" });
		const textarea = section.createEl("textarea", { cls: "lc-textarea" });
		textarea.rows = 3;
		textarea.value = value;
		textarea.setAttr("aria-label", label);
		textarea.onblur = () => onSave(textarea.value);
	}

	renderMilestonesInto(section: HTMLElement, quarter: Quarter, redraw: () => void) {
		section.createEl("h4", { text: "Monthly Milestones" });

		quarter.milestones.forEach((group, gi) => {
			const groupEl = section.createDiv({ cls: "lc-milestone-group" });
			const titleRow = groupEl.createDiv({ cls: "lc-milestone-group-header" });
			titleRow.createSpan({ text: group.month, cls: "lc-milestone-month" });
			if (group.title) titleRow.createSpan({ text: " — " + group.title, cls: "lc-milestone-title" });
			const delGroupBtn = titleRow.createEl("button", { text: "×", cls: "lc-milestone-remove" });
			delGroupBtn.type = "button";
			delGroupBtn.setAttr("aria-label", `Delete ${group.month} milestones`);
			delGroupBtn.onclick = () => {
				new ConfirmDeleteModal(this.plugin.app, `${group.month} milestones (${group.items.length} item${group.items.length === 1 ? "" : "s"})`, async () => {
					quarter.milestones.splice(gi, 1);
					await this.plugin.persist();
					redraw();
				}).open();
			};

			const itemsList = groupEl.createDiv({ cls: "lc-milestone-items" });
			group.items.forEach((item, ii) => {
				const row = itemsList.createDiv({ cls: "lc-milestone-item" });
				const cb = row.createEl("input", { cls: "lc-milestone-checkbox" });
				cb.type = "checkbox";
				cb.checked = item.done;
				cb.setAttr("aria-label", item.text);
				cb.onchange = async () => {
					item.done = cb.checked;
					await this.plugin.persist();
					if (item.done) {
						row.addClass("lc-milestone-item-pop");
						const allDone = group.items.every((it) => it.done);
						if (allDone) {
							new Notice(`🎉 ${group.month} milestones all done!`);
							groupEl.addClass("lc-milestone-group-celebrate");
							window.setTimeout(() => groupEl.removeClass("lc-milestone-group-celebrate"), 1400);
						}
					}
					redraw();
				};
				row.createSpan({ text: item.text, cls: "lc-milestone-item-text" + (item.done ? " lc-milestone-item-done" : "") });
				const delItemBtn = row.createEl("button", { text: "×", cls: "lc-milestone-remove" });
				delItemBtn.type = "button";
				delItemBtn.setAttr("aria-label", `Delete "${item.text}"`);
				delItemBtn.onclick = async () => {
					group.items.splice(ii, 1);
					await this.plugin.persist();
					redraw();
				};
			});

			const addItemRow = groupEl.createDiv({ cls: "lc-milestone-add-row" });
			const addItemInput = addItemRow.createEl("input", { cls: "lc-inline-input" });
			addItemInput.placeholder = "Add a milestone item…";
			addItemInput.setAttr("aria-label", `Add a milestone item to ${group.month}`);
			const addItemBtn = addItemRow.createEl("button", { text: "+", cls: "lc-icon-btn" });
			addItemBtn.type = "button";
			addItemBtn.setAttr("aria-label", "Add item");
			addItemBtn.onclick = async () => {
				if (!addItemInput.value.trim()) return;
				group.items.push({ text: addItemInput.value.trim(), done: false });
				await this.plugin.persist();
				redraw();
			};
		});

		const addGroupRow = section.createDiv({ cls: "lc-milestone-add-group" });
		const monthInput = addGroupRow.createEl("input", { cls: "lc-inline-input" });
		monthInput.placeholder = "Month, e.g. October 2026";
		monthInput.setAttr("aria-label", "New milestone month");
		const titleInput = addGroupRow.createEl("input", { cls: "lc-inline-input" });
		titleInput.placeholder = "Title, e.g. Scale & Convert";
		titleInput.setAttr("aria-label", "New milestone month title");
		const addGroupBtn = addGroupRow.createEl("button", { text: "+ Add Month" });
		addGroupBtn.type = "button";
		addGroupBtn.onclick = async () => {
			if (!monthInput.value.trim()) return;
			quarter.milestones.push({ month: monthInput.value.trim(), title: titleInput.value.trim(), items: [] });
			await this.plugin.persist();
			redraw();
		};
	}

	renderCheckinsInto(section: HTMLElement, quarter: Quarter, redraw: () => void) {
		section.addClass("lc-quarter-section");
		section.createEl("h4", { text: "Check-ins" });

		renderCheckinTodayForm(section, this.plugin, quarter, () => {
			redraw();
			this.plugin.refreshDailyBlocksOnly();
		});

		const heatmap = buildCheckinHeatmap(quarter);
		if (heatmap) section.appendChild(heatmap);

		const dates = Object.keys(quarter.checkins).sort().reverse();
		if (dates.length) {
			const history = section.createDiv({ cls: "lc-checkin-history" });
			for (const date of dates.slice(0, 30)) {
				const row = history.createDiv({ cls: "lc-checkin-history-row" });
				row.createSpan({ text: date, cls: "lc-checkin-history-date" });
				const values = quarter.checkins[date];
				row.createSpan({
					text: quarter.checkinFields.map((f) => `${f.label}: ${values[f.key] ?? "-"}`).join("   ·   "),
					cls: "lc-checkin-history-values",
				});
			}
		}
	}

	renderPastQuarters(container: HTMLElement, currentId: string | null) {
		const past = this.plugin.data.quarters.filter((q) => q.id !== currentId);
		if (!past.length) return;
		const section = container.createDiv({ cls: "lc-quarter-section" });
		const toggle = section.createEl("h4", { text: `▸ Past Quarters (${past.length})`, cls: "lc-collapsible-toggle" });
		const list = section.createDiv({ cls: "lc-collapsible-body" });
		toggle.onclick = () => {
			const nowOpen = !list.hasClass("lc-collapsible-body-open");
			list.toggleClass("lc-collapsible-body-open", nowOpen);
			toggle.setText(`${nowOpen ? "▾" : "▸"} Past Quarters (${past.length})`);
		};
		for (const q of past) {
			const outcome = this.plugin.data.outcomes.find((o) => o.id === q.outcomeId);
			const card = list.createDiv({ cls: "lc-quarter-past-card" });
			const header = card.createDiv({ cls: "lc-outcome-header" });
			header.createDiv({ text: q.id, cls: "lc-outcome-title" });
			header.createSpan({ text: q.status, cls: "lc-outcome-status lc-outcome-status-" + q.status });
			if (q.priority) card.createDiv({ text: q.priority, cls: "lc-outcome-metric" });
			if (outcome) card.createDiv({ text: `Ladders up to: ${outcome.name}`, cls: "lc-outcome-category" });
			const actions = card.createDiv({ cls: "lc-outcome-actions lc-quarter-past-actions" });
			const editBtn = actions.createEl("button", { text: "✏️", cls: "lc-icon-btn" });
			editBtn.type = "button";
			editBtn.setAttr("aria-label", `Edit ${q.id}`);
			editBtn.onclick = () => new QuarterFormModal(this.plugin, q, () => this.render()).open();
			const delBtn = actions.createEl("button", { text: "🗑", cls: "lc-icon-btn" });
			delBtn.type = "button";
			delBtn.setAttr("aria-label", `Delete ${q.id}`);
			delBtn.onclick = () => {
				new ConfirmDeleteModal(this.plugin.app, q.id, async () => {
					this.plugin.data.quarters = this.plugin.data.quarters.filter((qq) => qq.id !== q.id);
					await this.plugin.persist();
					this.render();
				}).open();
			};
		}
	}
}

// ---- Modals ----

class ConfirmDeleteModal extends Modal {
	name: string;
	onConfirm: () => void;

	constructor(app: App, name: string, onConfirm: () => void) {
		super(app);
		this.name = name;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("lc-modal");
		contentEl.createEl("h3", { text: `Delete "${this.name}"?` });
		contentEl.createEl("p", { text: "This can't be undone." });
		const footer = contentEl.createDiv({ cls: "lc-modal-footer" });
		const cancelBtn = footer.createEl("button", { text: "Cancel" });
		cancelBtn.type = "button";
		cancelBtn.onclick = () => this.close();
		const delBtn = footer.createEl("button", { text: "Delete", cls: "mod-warning" });
		delBtn.type = "button";
		delBtn.onclick = () => {
			this.onConfirm();
			this.close();
		};
	}
}

class OutcomeFormModal extends Modal {
	plugin: LifeCompassPlugin;
	existing: Outcome | null;
	onDone: () => void;
	values: {
		name: string;
		visionCategory: string;
		deadline: string;
		status: GoalStatus;
		successMetric: string;
		why: string;
		baseline: string;
		progress: number;
	};

	constructor(plugin: LifeCompassPlugin, existing: Outcome | null, onDone: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.existing = existing;
		this.onDone = onDone;
		this.values = existing
			? {
					name: existing.name,
					visionCategory: existing.visionCategory,
					deadline: existing.deadline,
					status: existing.status,
					successMetric: existing.successMetric,
					why: existing.why,
					baseline: existing.baseline ?? "",
					progress: existing.progress ?? 0,
			  }
			: {
					name: "",
					visionCategory: WHEEL_CATEGORIES[0].key,
					deadline: "",
					status: "active",
					successMetric: "",
					why: "",
					baseline: "",
					progress: 0,
			  };
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("lc-modal");
		contentEl.createEl("h3", { text: this.existing ? "Edit Outcome" : "New Outcome" });

		new Setting(contentEl).setName("Name").addText((t) => t.setValue(this.values.name).onChange((v) => (this.values.name = v)));
		new Setting(contentEl).setName("Vision Category").addDropdown((dd) => {
			WHEEL_CATEGORIES.forEach((c) => dd.addOption(c.key, c.label));
			dd.setValue(this.values.visionCategory).onChange((v) => (this.values.visionCategory = v));
		});
		new Setting(contentEl).setName("Deadline").addText((t) => {
			t.inputEl.type = "date";
			t.setValue(this.values.deadline).onChange((v) => (this.values.deadline = v));
		});
		new Setting(contentEl).setName("Status").addDropdown((dd) => {
			dd.addOption("active", "Active");
			dd.addOption("done", "Done");
			dd.addOption("missed", "Missed");
			dd.setValue(this.values.status).onChange((v) => (this.values.status = v as GoalStatus));
		});
		new Setting(contentEl)
			.setName("Success Metric")
			.addTextArea((t) => t.setValue(this.values.successMetric).onChange((v) => (this.values.successMetric = v)));
		new Setting(contentEl).setName("Why").addTextArea((t) => t.setValue(this.values.why).onChange((v) => (this.values.why = v)));
		new Setting(contentEl)
			.setName("Baseline (optional)")
			.addTextArea((t) => t.setValue(this.values.baseline).onChange((v) => (this.values.baseline = v)));
		new Setting(contentEl)
			.setName("Progress")
			.setDesc("How far along toward the Success Metric, 0-100%.")
			.addSlider((s) =>
				s
					.setLimits(0, 100, 5)
					.setValue(this.values.progress)
					.setDynamicTooltip()
					.onChange((v) => (this.values.progress = v))
			);

		const footer = contentEl.createDiv({ cls: "lc-modal-footer" });
		const saveBtn = footer.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.type = "button";
		saveBtn.onclick = async () => {
			if (!this.values.name.trim()) {
				new Notice("Name is required.");
				return;
			}
			const now = todayStr();
			if (this.existing) {
				this.existing.name = this.values.name.trim();
				this.existing.visionCategory = this.values.visionCategory;
				this.existing.deadline = this.values.deadline;
				this.existing.status = this.values.status;
				this.existing.successMetric = this.values.successMetric;
				this.existing.why = this.values.why;
				this.existing.baseline = this.values.baseline || undefined;
				this.existing.progress = this.values.progress;
				this.existing.updatedAt = now;
			} else {
				this.plugin.data.outcomes.push({
					id: uid(slugify(this.values.name)),
					name: this.values.name.trim(),
					visionCategory: this.values.visionCategory,
					deadline: this.values.deadline,
					status: this.values.status,
					successMetric: this.values.successMetric,
					why: this.values.why,
					baseline: this.values.baseline || undefined,
					progress: this.values.progress,
					createdAt: now,
					updatedAt: now,
				});
			}
			await this.plugin.persist();
			this.onDone();
			this.close();
		};
	}
}

class QuarterFormModal extends Modal {
	plugin: LifeCompassPlugin;
	existing: Quarter | null;
	onDone: () => void;
	values: {
		id: string;
		outcomeId: string;
		deadline: string;
		status: GoalStatus;
		successMetric: string;
		priority: string;
		why: string;
	};
	// A separate mutable draft (not saved until Save is clicked, same as
	// every other field here) rendered as one row per field with a name
	// input + number/text toggle + remove button, instead of a raw
	// "key:type, key:type" text box.
	checkinFieldsDraft: CheckinField[];

	constructor(plugin: LifeCompassPlugin, existing: Quarter | null, onDone: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.existing = existing;
		this.onDone = onDone;
		this.checkinFieldsDraft = existing ? existing.checkinFields.map((f) => ({ ...f })) : [];
		this.values = existing
			? {
					id: existing.id,
					outcomeId: existing.outcomeId,
					deadline: existing.deadline,
					status: existing.status,
					successMetric: existing.successMetric,
					priority: existing.priority,
					why: existing.why,
			  }
			: {
					id: "",
					outcomeId: plugin.data.outcomes[0]?.id ?? "",
					deadline: "",
					status: "active",
					successMetric: "",
					priority: "",
					why: "",
			  };
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("lc-modal");
		contentEl.createEl("h3", { text: this.existing ? "Edit Quarter" : "New Quarter" });

		if (this.plugin.data.outcomes.length === 0) {
			contentEl.createEl("p", { text: "Add an Outcome first — a Quarter needs something to ladder up to." });
			return;
		}

		if (!this.existing) {
			new Setting(contentEl).setName("Quarter ID").setDesc("e.g. 2026-Q4").addText((t) => t.setValue(this.values.id).onChange((v) => (this.values.id = v.trim())));
		}
		new Setting(contentEl).setName("Outcome").addDropdown((dd) => {
			this.plugin.data.outcomes.forEach((o) => dd.addOption(o.id, o.name));
			dd.setValue(this.values.outcomeId).onChange((v) => (this.values.outcomeId = v));
		});
		new Setting(contentEl).setName("Deadline").addText((t) => {
			t.inputEl.type = "date";
			t.setValue(this.values.deadline).onChange((v) => (this.values.deadline = v));
		});
		new Setting(contentEl).setName("Status").addDropdown((dd) => {
			dd.addOption("active", "Active");
			dd.addOption("done", "Done");
			dd.addOption("missed", "Missed");
			dd.setValue(this.values.status).onChange((v) => (this.values.status = v as GoalStatus));
		});
		new Setting(contentEl)
			.setName("Success Metric")
			.addTextArea((t) => t.setValue(this.values.successMetric).onChange((v) => (this.values.successMetric = v)));
		new Setting(contentEl)
			.setName("Priority")
			.setDesc("The ONE Wildly Important Goal for this quarter.")
			.addTextArea((t) => t.setValue(this.values.priority).onChange((v) => (this.values.priority = v)));
		new Setting(contentEl).setName("Why").addTextArea((t) => t.setValue(this.values.why).onChange((v) => (this.values.why = v)));

		contentEl.createEl("div", { text: "Check-in fields", cls: "lc-field-label" });
		contentEl.createEl("p", {
			text: "What you'll log each day for this quarter (e.g. emails sent, current phase).",
			cls: "setting-item-description",
		});
		const fieldsList = contentEl.createDiv({ cls: "lc-checkin-field-builder" });
		const redrawFields = () => {
			fieldsList.empty();
			this.checkinFieldsDraft.forEach((field, i) => {
				const row = fieldsList.createDiv({ cls: "lc-checkin-field-builder-row" });
				const nameInput = row.createEl("input", { cls: "lc-inline-input" });
				nameInput.placeholder = "Field name, e.g. emails";
				nameInput.value = field.label;
				nameInput.setAttr("aria-label", "Check-in field name");
				nameInput.oninput = () => {
					field.key = slugify(nameInput.value) || `field-${i}`;
					field.label = nameInput.value;
				};
				const typeSelect = row.createEl("select", { cls: "dropdown" });
				typeSelect.setAttr("aria-label", "Check-in field type");
				typeSelect.createEl("option", { text: "Number", value: "number" });
				typeSelect.createEl("option", { text: "Text", value: "text" });
				typeSelect.value = field.type;
				typeSelect.onchange = () => {
					field.type = typeSelect.value as CheckinField["type"];
				};
				const removeBtn = row.createEl("button", { text: "×", cls: "lc-milestone-remove" });
				removeBtn.type = "button";
				removeBtn.setAttr("aria-label", "Remove this field");
				removeBtn.onclick = () => {
					this.checkinFieldsDraft.splice(i, 1);
					redrawFields();
				};
			});
		};
		redrawFields();
		const addFieldBtn = contentEl.createEl("button", { text: "+ Add field", cls: "lc-icon-btn" });
		addFieldBtn.type = "button";
		addFieldBtn.onclick = () => {
			this.checkinFieldsDraft.push({ key: `field-${this.checkinFieldsDraft.length}`, label: "", type: "number" });
			redrawFields();
		};

		const footer = contentEl.createDiv({ cls: "lc-modal-footer" });
		const saveBtn = footer.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.type = "button";
		saveBtn.onclick = async () => {
			const id = (this.existing ? this.existing.id : this.values.id).trim();
			if (!id) {
				new Notice("Quarter ID is required.");
				return;
			}
			if (this.checkinFieldsDraft.some((f) => !f.label.trim())) {
				new Notice("Give every check-in field a name, or remove the blank one(s).");
				return;
			}
			const checkinFields: CheckinField[] = this.checkinFieldsDraft.map((f) => ({ key: f.key, label: f.label.trim(), type: f.type }));
			const now = todayStr();

			if (this.existing) {
				this.existing.outcomeId = this.values.outcomeId;
				this.existing.deadline = this.values.deadline;
				this.existing.status = this.values.status;
				this.existing.successMetric = this.values.successMetric;
				this.existing.priority = this.values.priority;
				this.existing.why = this.values.why;
				this.existing.checkinFields = checkinFields;
				this.existing.updatedAt = now;
			} else {
				if (this.plugin.data.quarters.some((q) => q.id === id)) {
					new Notice(`A quarter with id "${id}" already exists.`);
					return;
				}
				this.plugin.data.quarters.push({
					id,
					outcomeId: this.values.outcomeId,
					deadline: this.values.deadline,
					status: this.values.status,
					successMetric: this.values.successMetric,
					priority: this.values.priority,
					why: this.values.why,
					milestones: [],
					weeklyCommitments: "",
					dailyActionsPrompt: "",
					obstacles: "",
					checkinFields,
					checkins: {},
					createdAt: now,
					updatedAt: now,
				});
				this.plugin.data.currentQuarterId = id;
			}
			await this.plugin.persist();
			this.onDone();
			this.close();
		};
	}
}

// ---- Daily Note embed: a compact, daily-actionable slice of the current
// quarter (Priority reminder + today's check-in), not the full view — the
// Vision wheel and Outcome cards are periodic-review material, not
// something that belongs repeating on every Daily Note. ----

class DailyQuarterBlock extends MarkdownRenderChild {
	plugin: LifeCompassPlugin;

	constructor(containerEl: HTMLElement, plugin: LifeCompassPlugin) {
		super(containerEl);
		this.plugin = plugin;
	}

	onload() {
		this.plugin.registerDailyBlock(this);
		this.render();
	}

	onunload() {
		this.plugin.unregisterDailyBlock(this);
	}

	render() {
		const el = this.containerEl;
		el.empty();
		el.addClass("lc-daily-root");

		const current = this.plugin.data.quarters.find((q) => q.id === this.plugin.data.currentQuarterId);
		if (!current) {
			el.createDiv({ text: "No active quarter — open Life Compass to start one.", cls: "lc-outcomes-empty" });
			return;
		}

		const header = el.createDiv({ cls: "lc-daily-header" });
		header.createDiv({ text: `🎯 ${current.id}`, cls: "lc-daily-quarter-id" });
		if (current.deadline) header.createSpan({ text: daysUntil(current.deadline), cls: "lc-outcome-deadline" });

		if (current.priority) {
			el.createDiv({ text: current.priority, cls: "lc-daily-priority" });
		}

		renderCheckinTodayForm(el, this.plugin, current, () => {
			this.render();
			this.plugin.refreshMainViewOnly();
		});
	}
}

// ---- Sync plumbing (mirrors habit-tracker's Supabase architecture) ----

const SYNC_TABLE = "life_compass_data";

function mergeData(local: PluginData, remote: PluginData): PluginData {
	const vision: PluginData["vision"] = {};
	const visionKeys = new Set([...Object.keys(remote.vision ?? {}), ...Object.keys(local.vision ?? {})]);
	for (const k of visionKeys) {
		vision[k] = { ...(remote.vision?.[k] ?? { rating: 0, prose: "" }), ...(local.vision?.[k] ?? {}) };
	}

	const outcomesById = new Map<string, Outcome>();
	for (const o of remote.outcomes ?? []) outcomesById.set(o.id, o);
	for (const o of local.outcomes ?? []) outcomesById.set(o.id, o);

	const quartersById = new Map<string, Quarter>();
	for (const q of remote.quarters ?? []) quartersById.set(q.id, q);
	for (const q of local.quarters ?? []) {
		const existing = quartersById.get(q.id);
		quartersById.set(q.id, existing ? { ...existing, ...q, checkins: { ...existing.checkins, ...q.checkins } } : q);
	}

	return {
		vision,
		outcomes: Array.from(outcomesById.values()),
		quarters: Array.from(quartersById.values()),
		currentQuarterId: local.currentQuarterId ?? remote.currentQuarterId ?? null,
	};
}

export default class LifeCompassPlugin extends Plugin {
	data: PluginData;
	settings: PluginSettings;
	supabase: SupabaseClient | null = null;
	session: Session | null = null;
	private realtimeChannel: RealtimeChannel | null = null;
	private initializedCredsKey = "";
	private dailyBlocks: Set<DailyQuarterBlock> = new Set();

	async onload() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings);
		this.data = {
			vision: saved?.vision ?? DEFAULT_DATA.vision,
			outcomes: saved?.outcomes ?? DEFAULT_DATA.outcomes,
			quarters: saved?.quarters ?? DEFAULT_DATA.quarters,
			currentQuarterId: saved?.currentQuarterId ?? DEFAULT_DATA.currentQuarterId,
		};
		this.ensureVisionDefaults();

		this.addSettingTab(new LifeCompassSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new LifeCompassView(leaf, this));
		this.addRibbonIcon("compass", "Open Life Compass", () => this.activateView());
		this.addCommand({ id: "open-life-compass", name: "Open Life Compass", callback: () => this.activateView() });
		this.addCommand({
			id: "import-goals-notes",
			name: "Import from Goals/ notes and clean up",
			callback: () => this.runMigration(),
		});
		this.registerMarkdownCodeBlockProcessor("life-compass-daily", (_source, el, ctx) => {
			const block = new DailyQuarterBlock(el, this);
			ctx.addChild(block);
		});

		if (this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
			await this.initSupabase();
		}
	}

	onunload() {
		if (this.realtimeChannel) this.supabase?.removeChannel(this.realtimeChannel);
	}

	ensureVisionDefaults() {
		for (const cat of WHEEL_CATEGORIES) {
			if (!this.data.vision[cat.key]) this.data.vision[cat.key] = { rating: 0, prose: "" };
		}
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async runMigration() {
		const imported = await importFromGoalsNotes(this.app, this.data.vision);
		if (!imported) {
			new Notice("No Goals/ folder found — nothing to import.");
			return;
		}
		this.data = {
			vision: imported.vision,
			outcomes: imported.outcomes,
			quarters: imported.quarters,
			currentQuarterId: imported.currentQuarterId,
		};
		this.ensureVisionDefaults();
		await this.persist();
		this.refreshViews();
		new ConfirmMigrationModal(this.app, imported.summary, async () => {
			const folder = this.app.vault.getAbstractFileByPath("Goals");
			if (folder) await this.app.fileManager.trashFile(folder);
			new Notice("Goals/ notes moved to trash.");
		}).open();
	}

	async exportData() {
		const path = `Life Compass Backup ${todayStr()}.json`;
		const content = JSON.stringify(this.data, null, 2);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
		new Notice(`Exported to "${path}".`);
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

		const { data: row, error } = await this.supabase.from(SYNC_TABLE).select("data").eq("user_id", this.session.user.id).maybeSingle();
		if (error) {
			new Notice(`Couldn't reach Supabase to sync: ${error.message}. Using local data for now.`);
			return;
		}

		if (row?.data) {
			this.data = mergeData(this.data, row.data as PluginData);
			this.ensureVisionDefaults();
		}
		await this.persist();
		this.refreshViews();
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
					this.data = {
						vision: incoming.vision ?? {},
						outcomes: incoming.outcomes ?? [],
						quarters: incoming.quarters ?? [],
						currentQuarterId: incoming.currentQuarterId ?? null,
					};
					this.ensureVisionDefaults();
					this.saveLocal();
					this.refreshViews();
				}
			)
			.subscribe();
	}

	async saveLocal() {
		await this.saveData({
			settings: this.settings,
			vision: this.data.vision,
			outcomes: this.data.outcomes,
			quarters: this.data.quarters,
			currentQuarterId: this.data.currentQuarterId,
		});
	}

	// The local save always happens immediately (every caller needs fresh
	// data to re-render from), but the Supabase upload is debounced —
	// typing across several fields in a row previously re-uploaded the
	// ENTIRE dataset (all outcomes/quarters/check-in history) on every
	// single blur. Coalescing rapid edits into one upload after a short
	// quiet period cuts that down without changing any call site's
	// await-then-continue behavior.
	private supabasePushTimer: number | null = null;

	async persist() {
		await this.saveLocal();
		if (!this.supabase || !this.session) return;
		if (this.supabasePushTimer) window.clearTimeout(this.supabasePushTimer);
		this.supabasePushTimer = window.setTimeout(async () => {
			if (!this.supabase || !this.session) return;
			const { error } = await this.supabase.from(SYNC_TABLE).upsert({
				user_id: this.session.user.id,
				data: this.data,
				updated_at: new Date().toISOString(),
			});
			if (error) new Notice(`Sync failed, saved locally only: ${error.message}`);
		}, 800);
	}

	// Full refresh — used for realtime remote updates and after migration,
	// where every tab's data may have changed. Skips re-rendering the main
	// view while a textarea inside it is focused, so an incoming change
	// from another device can't wipe out something you're mid-typing.
	refreshViews() {
		this.refreshMainViewOnly();
		this.refreshDailyBlocksOnly();
	}

	refreshMainViewOnly() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
			if (!(leaf.view instanceof LifeCompassView)) return;
			const active = document.activeElement;
			const isTyping = active instanceof HTMLTextAreaElement && leaf.view.contentEl.contains(active);
			if (!isTyping) leaf.view.render();
		});
	}

	refreshDailyBlocksOnly() {
		for (const block of this.dailyBlocks) block.render();
	}

	registerDailyBlock(block: DailyQuarterBlock) {
		this.dailyBlocks.add(block);
	}

	unregisterDailyBlock(block: DailyQuarterBlock) {
		this.dailyBlocks.delete(block);
	}
}
