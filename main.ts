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

// Seed set — new vaults (and the old markdown migration) start with these,
// but the user can add/remove life areas from here on; the live list lives
// in PluginData.categories, not this constant.
const DEFAULT_WHEEL_CATEGORIES: WheelCategory[] = [
	{ key: "career-business", label: "Career / Business" },
	{ key: "money", label: "Money" },
	{ key: "health", label: "Health" },
	{ key: "relationships", label: "Relationships" },
	{ key: "lifestyle", label: "Lifestyle" },
	{ key: "personal-growth", label: "Personal Growth" },
	{ key: "contribution", label: "Contribution" },
];

const CATEGORY_COLORS = ["#22c55e", "#3b82f6", "#ef4444", "#f97316", "#a855f7", "#eab308", "#ec4899", "#14b8a6", "#f43f5e", "#84cc16"];
function categoryColor(categories: WheelCategory[], key: string): string {
	const i = categories.findIndex((c) => c.key === key);
	return CATEGORY_COLORS[Math.max(0, i) % CATEGORY_COLORS.length];
}
function categoryKeyForLabel(categories: WheelCategory[], label: string | undefined): string {
	const found = categories.find((c) => c.label === label);
	return found ? found.key : categories[0].key;
}
function uniqueCategoryKey(categories: WheelCategory[], label: string): string {
	const base = slugify(label);
	let key = base;
	let n = 2;
	while (categories.some((c) => c.key === key)) {
		key = `${base}-${n}`;
		n++;
	}
	return key;
}

// ---- Data model — Life Compass owns all of this itself now (no Goals/*.md
// dependency); only synced via Supabase like habit-tracker. ----

interface VisionCategoryData {
	rating: number; // 0 = unrated, 1-10 otherwise
	prose: string; // RPM Result: a vivid future-state description — as if it's already true
	purpose?: string; // RPM Purpose: why this category matters, broad/3-10yr — distinct from any one Outcome's own Why
}

type GoalStatus = "active" | "done" | "missed";

interface Outcome {
	id: string;
	name: string;
	visionCategory: string; // key into PluginData.categories
	startDate?: string; // YYYY-MM-DD
	deadline: string; // YYYY-MM-DD
	status: GoalStatus;
	successMetric: string;
	why: string;
	baseline?: string;
	obstacles?: string;
	progress: number; // 0-100, manually set
	linkedHabitIds: string[]; // explicit links to habit-tracker habit IDs, picked in the edit modal
	archived?: boolean; // hidden from the main Outcomes grid/Overview, kept (not deleted) under "Archived Goals" (UI label — this type/field stays "Outcome" internally)
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
	startDate?: string; // YYYY-MM-DD — the calendar quarter's first day, for auto-generated quarters
	deadline: string; // doubles as the calendar quarter's last day for auto-generated quarters
	status: GoalStatus;
	successMetric: string;
	priority: string; // the one Wildly Important Goal
	why: string;
	notes?: string; // catches anything that doesn't fit the standard sections
	milestones: MonthlyMilestone[];
	// Structured checklists (same MilestoneItem shape as Monthly Milestones),
	// not free-text — the Massive Action Plan is meant to be the most
	// actionable part of RPM, so it gets the same check-off interaction as
	// everything else instead of being a plain paragraph. Older saved data
	// may still have these as a single string; see normalizeActionItems().
	weeklyCommitments: MilestoneItem[];
	dailyActionsPrompt: MilestoneItem[];
	obstacles: string;
	checkinFields: CheckinField[];
	checkins: Record<string, Record<string, string | number>>; // date -> field values
	createdAt: string;
	updatedAt: string;
}

interface RatingHistoryEntry {
	date: string; // YYYY-MM-DD
	categoryKey: string;
	rating: number;
}

interface ProgressHistoryEntry {
	date: string; // YYYY-MM-DD
	outcomeId: string;
	progress: number;
}

interface PluginData {
	vision: Record<string, VisionCategoryData>;
	categories: WheelCategory[]; // the Wheel of Life's life areas — user-editable, seeded from DEFAULT_WHEEL_CATEGORIES
	outcomes: Outcome[];
	quarters: Quarter[];
	currentQuarterId: string | null;
	ratingHistory: RatingHistoryEntry[]; // one entry per category per calendar day, for the Trends tab
	progressHistory: ProgressHistoryEntry[]; // one entry per outcome per calendar day, for the Trends tab
}

const DEFAULT_DATA: PluginData = {
	vision: {},
	categories: [...DEFAULT_WHEEL_CATEGORIES],
	outcomes: [],
	quarters: [],
	currentQuarterId: null,
	ratingHistory: [],
	progressHistory: [],
};

// ---- Design Tweaks (live theme editor) ----------------------------------
// Ported from Habit Tracker's own Design Tweaks system, scoped to what this
// pilot pass actually restyles rather than porting all ~50 of its knobs —
// there is no Habit-Tracker-style day-cell grid or milestone bubble here,
// so knobs for those would be dead weight with nothing to drive. Same
// mechanism throughout: a spec array of tunable values, a sparse
// overrides map (only entries that differ from shipped defaults are
// stored), and a live-preview panel that writes CSS custom properties
// straight onto .lc-view-root.

type TweakKind = "color" | "range" | "select" | "toggle" | "font";

interface TweakDef {
	id: string;
	label: string;
	group: string;
	kind: TweakKind;
	def: string;
	cssVar?: string;
	bodyClass?: string;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	options?: Array<{ value: string; label: string }>;
	help?: string;
}

const TWEAK_FONT_STACKS: Array<{ value: string; label: string }> = [
	{ value: `"Bahnschrift", "Avenir Next Condensed", "Futura", "Segoe UI", system-ui, sans-serif`, label: "Bahnschrift (display)" },
	{ value: `"DM Sans", "Segoe UI", system-ui, sans-serif`, label: "DM Sans (body)" },
	{ value: `"Georgia", "Iowan Old Style", serif`, label: "Georgia (serif)" },
	{ value: `ui-monospace, "SF Mono", Menlo, monospace`, label: "Monospace" },
];

const LC_TWEAK_SPEC: TweakDef[] = [
	// ---- Color ----
	{ id: "accent", label: "Accent", group: "Color", kind: "color", def: "#a855f7", cssVar: "--lcx-glow-violet", help: "The main violet. Drives borders, the active tab, and focus rings." },
	{ id: "accentBright", label: "Accent (bright)", group: "Color", kind: "color", def: "#c084fc", cssVar: "--lcx-glow-violet-bright" },
	{ id: "accentSoft", label: "Accent (deep)", group: "Color", kind: "color", def: "#6d28d9", cssVar: "--lcx-violet-soft", help: "The darker end of the accent, used in the panel wash." },
	{ id: "bg", label: "Page ground", group: "Color", kind: "color", def: "#0a0713", cssVar: "--lcx-bg" },
	{ id: "bg2", label: "Page ground (top)", group: "Color", kind: "color", def: "#120a24", cssVar: "--lcx-bg-2" },
	{ id: "card", label: "Card fill", group: "Color", kind: "color", def: "#150d29", cssVar: "--lcx-card" },
	{ id: "text", label: "Text", group: "Color", kind: "color", def: "#f3ecff", cssVar: "--lcx-text" },
	{ id: "textMuted", label: "Text (muted)", group: "Color", kind: "color", def: "#b7a9d9", cssVar: "--lcx-text-muted" },
	{ id: "textFaint", label: "Text (faint)", group: "Color", kind: "color", def: "#8574ad", cssVar: "--lcx-text-faint" },
	{ id: "gold", label: "Momentum gold", group: "Color", kind: "color", def: "#fbbf24", cssVar: "--lcx-gold", help: "Momentum card, milestone \u201cdone\u201d treatment \u2014 the achievement/pride register, matching Habit Tracker\u2019s streak gold." },
	{ id: "goldBright", label: "Momentum gold (bright)", group: "Color", kind: "color", def: "#fde68a", cssVar: "--lcx-gold-bright" },
	{ id: "borderStrength", label: "Border strength", group: "Color", kind: "range", def: "30", cssVar: "--lcx-border-pct", min: 0, max: 100, step: 5, unit: "%", help: "How much accent shows in card outlines." },
	{ id: "green", label: "Success green", group: "Color", kind: "color", def: "#34d399", cssVar: "--lcx-green", help: "Goal status: Done." },
	{ id: "greenBright", label: "Success green (bright)", group: "Color", kind: "color", def: "#4ade80", cssVar: "--lcx-green-bright" },
	{ id: "red", label: "Alert red", group: "Color", kind: "color", def: "#f87171", cssVar: "--lcx-red", help: "Goal status: Missed." },

	// ---- Type ----
	{ id: "fontDisplay", label: "Display face", group: "Type", kind: "font", def: TWEAK_FONT_STACKS[0].value, cssVar: "--lcx-font-display", options: TWEAK_FONT_STACKS, help: "Card titles, the Priority line, big numbers." },
	{ id: "fontBody", label: "Body face", group: "Type", kind: "font", def: TWEAK_FONT_STACKS[1].value, cssVar: "--lcx-font-body", options: TWEAK_FONT_STACKS },
	{ id: "rootSize", label: "Overall scale", group: "Type", kind: "range", def: "1", cssVar: "--lcx-root-size", min: 0.8, max: 1.6, step: 0.05, unit: "em", help: "Scales the whole pane at once." },
	{ id: "tracking", label: "Label letter-spacing", group: "Type", kind: "range", def: "0.03", cssVar: "--lcx-tracking", min: -0.02, max: 0.3, step: 0.01, unit: "em", help: "Affects uppercase field labels like VISION and MOMENTUM." },

	// ---- Shape ----
	{ id: "radius", label: "Corner radius", group: "Shape", kind: "range", def: "12", cssVar: "--lcx-radius-base", min: 0, max: 28, step: 1, unit: "px", help: "Scales every rounded corner together." },
	{ id: "cardPadding", label: "Card padding", group: "Shape", kind: "range", def: "16", cssVar: "--lcx-card-pad", min: 6, max: 44, step: 1, unit: "px" },
	{ id: "cardGap", label: "Gap between cards", group: "Shape", kind: "range", def: "14", cssVar: "--lcx-card-gap", min: 0, max: 48, step: 1, unit: "px" },
	{ id: "hairline", label: "Outline weight", group: "Shape", kind: "range", def: "1", cssVar: "--lcx-hairline", min: 1, max: 4, step: 1, unit: "px" },

	// ---- Effects ----
	{ id: "glow", label: "Glow strength", group: "Effects", kind: "range", def: "100", cssVar: "--lcx-glow-pct", min: 0, max: 250, step: 10, unit: "%", help: "0 turns every neon bloom off." },
	{ id: "shadow", label: "Shadow depth", group: "Effects", kind: "range", def: "100", cssVar: "--lcx-shadow-pct", min: 0, max: 250, step: 10, unit: "%" },
	{ id: "motion", label: "Motion speed", group: "Effects", kind: "range", def: "100", cssVar: "--lcx-motion-pct", min: 0, max: 300, step: 10, unit: "%", help: "0 stops animation. Your OS reduced-motion setting still overrides this." },
	{ id: "hoverLift", label: "Cards lift on hover", group: "Effects", kind: "toggle", def: "on", bodyClass: "lc-no-hover-lift" },
	{ id: "panelWash", label: "Panel background wash", group: "Effects", kind: "toggle", def: "on", bodyClass: "lc-no-panel-wash", help: "The soft radial haze behind the pane." },
];

const TWEAK_GROUPS = ["Color", "Type", "Shape", "Effects"];

interface CopyDef {
	id: string;
	label: string;
	group: string;
	def: string;
	vars?: string[];
	multiline?: boolean;
	help?: string;
}

const COPY_GROUP_OVERVIEW = "Text \u00b7 Overview";
const COPY_GROUP_GOALS = "Text \u00b7 Goals";

// Editable strings for the pilot (Overview) pass. Extends to the other
// tabs as they get their own restyle — same sparse-storage rule as the
// tweaks above: only ids present in designCopy differ from shipped text.
const COPY_SPEC: CopyDef[] = [
	{ id: "overview.visionLabel", label: "Vision card header", group: COPY_GROUP_OVERVIEW, def: "\ud83c\udfaf Vision" },
	{ id: "overview.visionNudgeLabel", label: "Vision nudge header", group: COPY_GROUP_OVERVIEW, def: "\u270d\ufe0f Vision still needs writing" },
	{ id: "overview.quarterLabel", label: "Quarter card header", group: COPY_GROUP_OVERVIEW, def: "\ud83d\udcc5 Current Quarter" },
	{ id: "overview.noActiveQuarter", label: "No active quarter", group: COPY_GROUP_OVERVIEW, def: "No active quarter." },
	{ id: "overview.goalsLabel", label: "Goals card header", group: COPY_GROUP_OVERVIEW, def: "\ud83d\ude80 Goals" },
	{ id: "overview.momentumLabel", label: "Momentum card header", group: COPY_GROUP_OVERVIEW, def: "\ud83c\udf1f Momentum" },

	{ id: "goals.addButton", label: "Add-goal button", group: COPY_GROUP_GOALS, def: "+ Add Goal" },
	{ id: "goals.emptyState", label: "No goals at all", group: COPY_GROUP_GOALS, def: "No goals yet \u2014 add your first one above." },
	{ id: "goals.emptyActiveState", label: "No active goals", group: COPY_GROUP_GOALS, def: "No active goals \u2014 add one above, or restore one from Archived Goals below." },
	{ id: "goals.systemLabel", label: "Supporting-habits header", group: COPY_GROUP_GOALS, def: "Goal Supporting Habits" },
	{ id: "goals.systemEmpty", label: "No linked habits", group: COPY_GROUP_GOALS, def: "No linked habits yet" },
];

const COPY_GROUPS = [COPY_GROUP_OVERVIEW, COPY_GROUP_GOALS];
// Plain loop rather than Object.fromEntries: this build targets ES2018.
const COPY_BY_ID: Record<string, CopyDef> = {};
for (const c of COPY_SPEC) {
	COPY_BY_ID[c.id] = c;
}

function copyText(overrides: Record<string, string>, id: string, vars?: Record<string, string | number>): string {
	const def = COPY_BY_ID[id];
	if (!def) return "";
	const raw = overrides[id] !== undefined && overrides[id] !== "" ? overrides[id] : def.def;
	if (!vars) return raw;
	return raw.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

function tweakValue(tweaks: Record<string, string>, id: string): string {
	const def = LC_TWEAK_SPEC.find((t) => t.id === id);
	if (!def) return "";
	const raw = tweaks[id];
	return raw === undefined || raw === "" ? def.def : raw;
}

// Pushes the whole tweak set onto a root element as inline custom
// properties plus structural classes. Called on every render() and on
// every live-preview edit inside the panel.
function applyTweaksTo(el: HTMLElement, tweaks: Record<string, string>) {
	for (const def of LC_TWEAK_SPEC) {
		const value = tweakValue(tweaks, def.id);
		if (def.cssVar) {
			el.style.setProperty(def.cssVar, def.unit && def.kind === "range" ? `${value}${def.unit}` : value);
		}
		if (!def.bodyClass) continue;
		if (def.kind === "toggle") {
			el.toggleClass(def.bodyClass, value !== "on");
		} else if (def.kind === "select") {
			(def.options ?? []).forEach((opt) => el.toggleClass(`${def.bodyClass}-${opt.value}`, value === opt.value));
		}
	}
}

interface PluginSettings {
	supabaseUrl: string;
	supabaseAnonKey: string;
	lastDigestShownDate?: string; // YYYY-MM-DD — guards the weekly digest modal from re-showing more than once per day
	// Design Tweaks overrides — sparse maps, only entries that differ from
	// LC_TWEAK_SPEC/COPY_SPEC's shipped defaults are ever stored. See the
	// Design Tweaks section above.
	designTweaks: Record<string, string>;
	designCopy: Record<string, string>;
}

const DEFAULT_SETTINGS: PluginSettings = { supabaseUrl: "", supabaseAnonKey: "", designTweaks: {}, designCopy: {} };

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

// weeklyCommitments/dailyActionsPrompt used to be a single free-text
// string; saved data from before that change (and data read straight off
// disk/Supabase without going through TS types) may still be a raw
// string at runtime despite the type now declaring MilestoneItem[]. Splits
// each non-blank line into its own unchecked item so nothing is lost —
// called defensively at render time rather than in every load path.
function normalizeActionItems(value: unknown): MilestoneItem[] {
	if (Array.isArray(value)) return value as MilestoneItem[];
	if (typeof value === "string" && value.trim()) {
		return value
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((text) => ({ text, done: false }));
	}
	return [];
}

// Every field in this plugin saves silently on blur — no confirmation a
// given field actually persisted. A brief pulse on the field itself (CSS
// animation, see .lc-save-flash in styles.css) closes that gap cheaply,
// in the same spirit as Habit Tracker's cell-pop on check-in.
// Overview's home-screen cards are div-based buttons (role="button" +
// tabindex, not a real <button>, so they can still hold nested content) —
// this wires up both mouse and keyboard activation identically rather than
// leaving Enter/Space silently do nothing.
function makeCardClickable(el: HTMLElement, onActivate: () => void) {
	el.setAttr("role", "button");
	el.setAttr("tabindex", "0");
	el.addClass("lc-overview-card-clickable");
	el.onclick = onActivate;
	el.onkeydown = (e: KeyboardEvent) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		onActivate();
	};
}

function flashSaved(el: HTMLElement) {
	el.classList.remove("lc-save-flash");
	// Force a reflow so re-adding the class restarts the animation even if
	// it was just removed (e.g. two saves in quick succession).
	void el.offsetWidth;
	el.classList.add("lc-save-flash");
	window.setTimeout(() => el.classList.remove("lc-save-flash"), 700);
}

function formatDate(d: Date): string {
	const pad = (n: number) => (n < 10 ? "0" + n : "" + n);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Calendar-quarter boundaries — Q1 Jan 1-Mar 31, Q2 Apr 1-Jun 30, Q3 Jul
// 1-Sep 30, Q4 Oct 1-Dec 31. Using month-end dates rather than day counts
// means leap years never need special-casing here.
function quarterDateRange(year: number, q: 1 | 2 | 3 | 4): { start: string; end: string } {
	const startMonth = (q - 1) * 3;
	const start = new Date(year, startMonth, 1);
	const end = new Date(year, startMonth + 3, 0); // day 0 of the next month = last day of this quarter
	return { start: formatDate(start), end: formatDate(end) };
}

function quarterIdForDate(d: Date): string {
	return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

function formatQuarterRange(q: Quarter): string {
	if (!q.startDate || !q.deadline) return "";
	const fmt = (s: string) => {
		const d = new Date(s);
		return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("default", { month: "short", day: "numeric" });
	};
	const endYear = new Date(q.deadline).getFullYear();
	return `${fmt(q.startDate)} – ${fmt(q.deadline)}, ${Number.isNaN(endYear) ? "" : endYear}`;
}

// Ensures all four calendar quarters of `year` exist in `data.quarters`,
// auto-generating any that are missing with their real date ranges already
// filled in — Outcome/Priority/Why are left blank for the user to fill in,
// same as a manually created quarter. Returns the ids that were newly
// added (empty if the year's quarters already existed).
function ensureQuartersForYear(data: PluginData, year: number): string[] {
	const added: string[] = [];
	for (const q of [1, 2, 3, 4] as const) {
		const id = `${year}-Q${q}`;
		if (data.quarters.some((existing) => existing.id === id)) continue;
		const { start, end } = quarterDateRange(year, q);
		const now = todayStr();
		data.quarters.push({
			id,
			outcomeId: "",
			startDate: start,
			deadline: end,
			status: "active",
			successMetric: "",
			priority: "",
			why: "",
			milestones: [],
			weeklyCommitments: [],
			dailyActionsPrompt: [],
			obstacles: "",
			checkinFields: [],
			checkins: {},
			createdAt: now,
			updatedAt: now,
		});
		added.push(id);
	}
	if (added.length) data.quarters.sort((a, b) => a.id.localeCompare(b.id));
	return added;
}

const QUARTER_ID_PATTERN = /^\d{4}-Q[1-4]$/;

// One-time, idempotent cleanup for quarters created before quarter ids were
// locked to the YYYY-Qn format (the old free-text "Quarter ID" field let a
// hand-typed id like "Q3" get created alongside an auto-generated "2026-Q3"
// covering the same period). Merges the legacy quarter's real data onto the
// matching auto-generated placeholder (or just renames it if no placeholder
// exists yet) and fixes up currentQuarterId. Returns true if anything changed,
// so the caller knows whether to persist immediately.
function migrateLegacyQuarterIds(data: PluginData): boolean {
	let changed = false;
	for (const legacy of data.quarters.filter((q) => !QUARTER_ID_PATTERN.test(q.id))) {
		const originalId = legacy.id;
		const targetId = legacy.startDate ? quarterIdForDate(new Date(legacy.startDate)) : quarterIdForDate(new Date());
		const placeholder = data.quarters.find((q) => q.id === targetId);
		if (placeholder) {
			Object.assign(placeholder, {
				...legacy,
				id: targetId,
				startDate: placeholder.startDate,
				deadline: placeholder.deadline,
			});
			data.quarters = data.quarters.filter((q) => q !== legacy);
		} else {
			legacy.id = targetId;
		}
		if (data.currentQuarterId === originalId) data.currentQuarterId = targetId;
		changed = true;
	}
	return changed;
}

// One entry per category/outcome per calendar day — same-day re-clicks
// update the existing entry in place rather than spamming a new one, so
// the Trends tab's line charts read as a real trend, not click noise.
function recordRatingHistory(data: PluginData, categoryKey: string, rating: number) {
	const date = todayStr();
	const existing = data.ratingHistory.find((e) => e.date === date && e.categoryKey === categoryKey);
	if (existing) existing.rating = rating;
	else data.ratingHistory.push({ date, categoryKey, rating });
}

function recordProgressHistory(data: PluginData, outcomeId: string, progress: number) {
	const date = todayStr();
	const existing = data.progressHistory.find((e) => e.date === date && e.outcomeId === outcomeId);
	if (existing) existing.progress = progress;
	else data.progressHistory.push({ date, outcomeId, progress });
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

// Shared by the Weekly Digest modal and the Overview tab's momentum section
// — was previously only computed inline in the digest, risking drift.
function milestoneProgress(quarter: Quarter): { done: number; total: number } {
	const allItems: MilestoneItem[] = ([] as MilestoneItem[]).concat(...quarter.milestones.map((m) => m.items));
	return { done: allItems.filter((i) => i.done).length, total: allItems.length };
}

// Consecutive calendar days (ending today, or yesterday if today isn't
// logged yet — same "today doesn't break the streak" rule as habit
// streaks) that have at least one check-in entry for this quarter.
function checkinStreak(quarter: Quarter): number {
	const days = new Set(Object.keys(quarter.checkins));
	let streak = 0;
	const cursor = new Date();
	if (!days.has(todayStr())) cursor.setDate(cursor.getDate() - 1);
	while (days.has(formatDate(cursor))) {
		streak++;
		cursor.setDate(cursor.getDate() - 1);
	}
	return streak;
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
	kind?: "habit" | "task"; // from habit-tracker's ItemKind — tasks link the same way habits do
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

// Same cross-plugin entries read as getHabitStreak, but a fixed 7-day
// completion count (today back to 6 days ago) for the Weekly Digest modal
// rather than a running streak.
function countWeeklyCompletions(app: App, habitId: string): number {
	const anyApp = app as unknown as {
		plugins: { plugins: Record<string, { data?: { entries?: Record<string, Record<string, unknown>> } }> };
	};
	const entries = anyApp.plugins?.plugins?.["habit-tracker"]?.data?.entries?.[habitId];
	if (!entries) return 0;
	let count = 0;
	let cursor = new Date();
	for (let i = 0; i < 7; i++) {
		if (entries[formatDate(cursor)]) count++;
		cursor = new Date(cursor.getTime() - 86400000);
	}
	return count;
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
		for (const cat of DEFAULT_WHEEL_CATEGORIES) {
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
		if (fm["Vision Category"] && !DEFAULT_WHEEL_CATEGORIES.some((c) => c.label === fm["Vision Category"])) {
			warnings.push(`"${file.basename}": Vision Category "${fm["Vision Category"]}" didn't match a known category — defaulted to "${DEFAULT_WHEEL_CATEGORIES[0].label}", check it.`);
		}
		outcomes.push({
			id,
			name: file.basename,
			visionCategory: categoryKeyForLabel(DEFAULT_WHEEL_CATEGORIES, fm["Vision Category"]),
			deadline: fm.Deadline ?? "",
			status: (fm.Status as GoalStatus) ?? "active",
			successMetric: fm["Success Metric"] ?? "",
			why: isPlaceholder(why) ? "" : why,
			baseline: isPlaceholder(baseline) ? undefined : baseline,
			obstacles: isPlaceholder(obstacles) ? undefined : obstacles,
			progress: 0,
			linkedHabitIds: [],
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
			warnings.push(`"${file.basename}": Goal link "${outcomeName}" didn't match any imported goal — defaulted to "${outcomes[0]?.name ?? "(none)"}", check it.`);
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
			weeklyCommitments: normalizeActionItems(isPlaceholder(weeklyCommitments) ? "" : weeklyCommitments),
			dailyActionsPrompt: normalizeActionItems(isPlaceholder(dailyActionsPrompt) ? "" : dailyActionsPrompt),
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

// Ported from Habit Tracker's own TweakPanel — same draft/live-preview/
// save/reset shape, retargeted at .lc-view-root and LifeCompassPlugin's
// own refreshMainViewOnly(). See the Design Tweaks section above for what
// isn't ported (the knobs/copy don't exist yet for tabs this pass doesn't
// touch).
class LcTweakPanel {
	plugin: LifeCompassPlugin;
	el: HTMLElement;
	draft: Record<string, string>;
	copyDraft: Record<string, string>;
	private onKeydown: (e: KeyboardEvent) => void;
	private static openInstance: LcTweakPanel | null = null;
	private savedCopySnapshot: Record<string, string>;

	constructor(plugin: LifeCompassPlugin) {
		this.plugin = plugin;
		this.draft = { ...plugin.settings.designTweaks };
		this.copyDraft = { ...plugin.settings.designCopy };
		this.savedCopySnapshot = { ...plugin.settings.designCopy };
	}

	static toggle(plugin: LifeCompassPlugin) {
		if (LcTweakPanel.openInstance) {
			LcTweakPanel.openInstance.close();
			return;
		}
		const panel = new LcTweakPanel(plugin);
		LcTweakPanel.openInstance = panel;
		panel.open();
	}

	open() {
		this.el = document.body.createDiv({ cls: "lc-tweak-panel" });
		this.renderHeader();
		const body = this.el.createDiv({ cls: "lc-tweak-body" });
		TWEAK_GROUPS.forEach((group, i) => this.renderGroup(body, group, i === 0));
		COPY_GROUPS.forEach((group) => this.renderCopyGroup(body, group));
		this.renderFooter();
		this.makeDraggable();
		this.onKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		document.addEventListener("keydown", this.onKeydown);
	}

	close() {
		document.removeEventListener("keydown", this.onKeydown);
		this.el?.remove();
		if (LcTweakPanel.openInstance === this) LcTweakPanel.openInstance = null;
		this.plugin.settings.designCopy = { ...this.savedCopySnapshot };
		this.plugin.refreshMainViewOnly();
	}

	private applyLive() {
		document.querySelectorAll<HTMLElement>(".lc-view-root").forEach((root) => applyTweaksTo(root, this.draft));
	}

	private set(id: string, value: string) {
		const def = LC_TWEAK_SPEC.find((t) => t.id === id);
		if (def && value === def.def) delete this.draft[id];
		else this.draft[id] = value;
		this.applyLive();
		this.refreshChangedCount();
	}

	private changedCount(): number {
		const tweaks = LC_TWEAK_SPEC.filter((t) => this.draft[t.id] !== undefined && this.draft[t.id] !== t.def).length;
		const copy = COPY_SPEC.filter((c) => this.copyDraft[c.id] !== undefined && this.copyDraft[c.id] !== c.def).length;
		return tweaks + copy;
	}

	private countEl: HTMLElement;

	private refreshChangedCount() {
		if (!this.countEl) return;
		const n = this.changedCount();
		this.countEl.setText(n === 0 ? "matching shipped defaults" : `${n} change${n === 1 ? "" : "s"} from default`);
		this.countEl.toggleClass("lc-tweak-count-dirty", n > 0);
	}

	private renderHeader() {
		const header = this.el.createDiv({ cls: "lc-tweak-header" });
		const titleWrap = header.createDiv({ cls: "lc-tweak-title-wrap" });
		titleWrap.createDiv({ cls: "lc-tweak-title", text: "Design Tweaks" });
		this.countEl = titleWrap.createDiv({ cls: "lc-tweak-count" });
		const closeBtn = header.createEl("button", { cls: "lc-tweak-close", text: "✕" });
		closeBtn.setAttr("aria-label", "Close Design Tweaks");
		closeBtn.onclick = () => this.close();
		this.refreshChangedCount();
	}

	private renderGroup(parent: HTMLElement, group: string, startOpen: boolean) {
		const section = parent.createDiv({ cls: "lc-tweak-section" });
		const head = section.createDiv({ cls: "lc-tweak-section-head" });
		head.setAttr("tabindex", "0");
		head.setAttr("role", "button");
		const caret = head.createSpan({ cls: "lc-tweak-caret", text: startOpen ? "▾" : "▸" });
		head.createSpan({ text: group });
		const content = section.createDiv({ cls: "lc-tweak-section-body" });
		if (!startOpen) content.addClass("lc-tweak-hidden");
		const toggle = () => {
			const nowHidden = content.hasClass("lc-tweak-hidden");
			content.toggleClass("lc-tweak-hidden", !nowHidden);
			caret.setText(nowHidden ? "▾" : "▸");
			head.setAttr("aria-expanded", nowHidden ? "true" : "false");
		};
		head.onclick = toggle;
		head.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
		head.setAttr("aria-expanded", startOpen ? "true" : "false");

		LC_TWEAK_SPEC.filter((t) => t.group === group).forEach((def) => this.renderControl(content, def));
	}

	private renderCopyGroup(parent: HTMLElement, group: string) {
		const section = parent.createDiv({ cls: "lc-tweak-section" });
		const head = section.createDiv({ cls: "lc-tweak-section-head" });
		head.setAttr("tabindex", "0");
		head.setAttr("role", "button");
		head.setAttr("aria-expanded", "false");
		const caret = head.createSpan({ cls: "lc-tweak-caret", text: "▸" });
		head.createSpan({ text: group });
		const content = section.createDiv({ cls: "lc-tweak-section-body lc-tweak-hidden" });
		const toggle = () => {
			const nowHidden = content.hasClass("lc-tweak-hidden");
			content.toggleClass("lc-tweak-hidden", !nowHidden);
			caret.setText(nowHidden ? "▾" : "▸");
			head.setAttr("aria-expanded", nowHidden ? "true" : "false");
		};
		head.onclick = toggle;
		head.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
		COPY_SPEC.filter((c) => c.group === group).forEach((def) => this.renderCopyControl(content, def));
	}

	private renderCopyControl(parent: HTMLElement, def: CopyDef) {
		const row = parent.createDiv({ cls: "lc-tweak-row lc-tweak-row-copy" });
		const labelRow = row.createDiv({ cls: "lc-tweak-copy-labelrow" });
		labelRow.createSpan({ cls: "lc-tweak-label", text: def.label });
		if (def.vars?.length) {
			labelRow.createSpan({ cls: "lc-tweak-vars", text: def.vars.map((v) => `{${v}}`).join(" ") });
		}
		if (def.help) labelRow.setAttr("title", def.help);

		const current = copyText(this.copyDraft, def.id);
		const input = def.multiline
			? row.createEl("textarea", { cls: "lc-tweak-textarea" })
			: row.createEl("input", { cls: "lc-tweak-text", type: "text" });
		input.value = current;
		if (def.multiline) (input as HTMLTextAreaElement).rows = Math.min(6, Math.ceil(current.length / 46) + 1);

		const commit = () => {
			const v = input.value;
			if (v === def.def || v.trim() === "") {
				delete this.copyDraft[def.id];
				if (v.trim() === "") input.value = def.def;
			} else {
				this.copyDraft[def.id] = v;
			}
			this.applyCopyLive();
			this.refreshChangedCount();
		};
		input.addEventListener("change", commit);
		input.addEventListener("blur", commit);
	}

	private applyCopyLive() {
		this.plugin.settings.designCopy = { ...this.copyDraft };
		this.plugin.refreshMainViewOnly();
	}

	private renderControl(parent: HTMLElement, def: TweakDef) {
		const row = parent.createDiv({ cls: "lc-tweak-row" });
		const labelWrap = row.createDiv({ cls: "lc-tweak-label-wrap" });
		const label = labelWrap.createDiv({ cls: "lc-tweak-label", text: def.label });
		if (def.help) label.setAttr("title", def.help);
		const valueEl = labelWrap.createDiv({ cls: "lc-tweak-value" });
		const control = row.createDiv({ cls: "lc-tweak-control" });
		const current = tweakValue(this.draft, def.id);

		const markValue = (v: string) => {
			if (def.kind === "range") valueEl.setText(`${v}${def.unit ?? ""}`);
			else if (def.kind === "toggle") valueEl.setText(v === "on" ? "on" : "off");
			else if (def.kind === "color") valueEl.setText(v);
			else valueEl.setText("");
		};
		markValue(current);

		if (def.kind === "color") {
			const swatch = control.createEl("input", { cls: "lc-tweak-color", type: "color" });
			swatch.value = current;
			const hex = control.createEl("input", { cls: "lc-tweak-hex", type: "text" });
			hex.value = current;
			swatch.addEventListener("input", () => {
				hex.value = swatch.value;
				markValue(swatch.value);
				this.set(def.id, swatch.value);
			});
			hex.addEventListener("change", () => {
				if (!/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) {
					hex.value = tweakValue(this.draft, def.id);
					return;
				}
				swatch.value = hex.value.trim();
				markValue(hex.value.trim());
				this.set(def.id, hex.value.trim());
			});
		} else if (def.kind === "range") {
			const slider = control.createEl("input", { cls: "lc-tweak-range", type: "range" });
			slider.min = String(def.min ?? 0);
			slider.max = String(def.max ?? 100);
			slider.step = String(def.step ?? 1);
			slider.value = current;
			slider.addEventListener("input", () => {
				markValue(slider.value);
				this.set(def.id, slider.value);
			});
		} else if (def.kind === "toggle") {
			const btn = control.createEl("button", { cls: "lc-tweak-toggle" });
			const paint = (v: string) => {
				btn.toggleClass("lc-tweak-toggle-on", v === "on");
				btn.setText(v === "on" ? "On" : "Off");
				btn.setAttr("aria-pressed", v === "on" ? "true" : "false");
			};
			paint(current);
			btn.onclick = () => {
				const next = tweakValue(this.draft, def.id) === "on" ? "off" : "on";
				paint(next);
				markValue(next);
				this.set(def.id, next);
			};
		} else {
			const sel = control.createEl("select", { cls: "lc-tweak-select" });
			(def.options ?? []).forEach((opt) => {
				const o = sel.createEl("option", { text: opt.label });
				o.value = opt.value;
			});
			sel.value = current;
			if (def.kind === "font") sel.style.fontFamily = current;
			sel.addEventListener("change", () => {
				if (def.kind === "font") sel.style.fontFamily = sel.value;
				this.set(def.id, sel.value);
			});
		}
	}

	private renderFooter() {
		const footer = this.el.createDiv({ cls: "lc-tweak-footer" });

		const saveBtn = footer.createEl("button", { cls: "lc-tweak-btn lc-tweak-btn-cta", text: "Save" });
		saveBtn.onclick = async () => {
			this.plugin.settings.designTweaks = { ...this.draft };
			this.plugin.settings.designCopy = { ...this.copyDraft };
			this.savedCopySnapshot = { ...this.copyDraft };
			await this.plugin.persist();
			this.plugin.refreshMainViewOnly();
			new Notice(`Design saved — ${this.changedCount()} tweak(s) applied.`);
		};

		const copyBtn = footer.createEl("button", { cls: "lc-tweak-btn", text: "Copy CSS" });
		copyBtn.onclick = async () => {
			const css = this.exportCss();
			await navigator.clipboard.writeText(css);
			new Notice("CSS copied — paste it into styles.css to make it the default.");
		};

		const resetBtn = footer.createEl("button", { cls: "lc-tweak-btn lc-tweak-btn-warn", text: "Reset" });
		resetBtn.onclick = () => {
			this.draft = {};
			this.copyDraft = {};
			this.applyLive();
			this.applyCopyLive();
			this.el.empty();
			this.renderHeader();
			const body = this.el.createDiv({ cls: "lc-tweak-body" });
			TWEAK_GROUPS.forEach((g, i) => this.renderGroup(body, g, i === 0));
			COPY_GROUPS.forEach((g) => this.renderCopyGroup(body, g));
			this.renderFooter();
			new Notice("Reverted to shipped defaults (not saved yet).");
		};
	}

	private exportCss(): string {
		const vars: string[] = [];
		const classes: string[] = [];
		for (const def of LC_TWEAK_SPEC) {
			const v = this.draft[def.id];
			if (v === undefined || v === def.def) continue;
			if (def.cssVar) {
				vars.push(`\t${def.cssVar}: ${v}${def.unit && def.kind === "range" ? def.unit : ""};`);
			} else if (def.bodyClass) {
				classes.push(
					def.kind === "toggle"
						? `${def.label}: ${v} → class .${def.bodyClass}`
						: `${def.label}: ${v} → class .${def.bodyClass}-${v}`
				);
			}
		}
		const copyLines: string[] = [];
		for (const def of COPY_SPEC) {
			const v = this.copyDraft[def.id];
			if (v === undefined || v === def.def) continue;
			copyLines.push(`\t{ id: "${def.id}", def: ${JSON.stringify(v)} },`);
		}
		if (!vars.length && !classes.length && !copyLines.length) return "/* No changes from the shipped design. */";
		let out = "";
		if (vars.length) out += `.lc-view-root {\n${vars.join("\n")}\n}\n`;
		if (classes.length) out += `\n/* Structural tweaks (applied as classes by applyTweaksTo):\n${classes.map((c) => `   ${c}`).join("\n")}\n*/\n`;
		if (copyLines.length) out += `\n/* Copy overrides — paste these \`def\` values into COPY_SPEC in main.ts:\n${copyLines.join("\n")}\n*/\n`;
		return out;
	}

	private makeDraggable() {
		const header = this.el.querySelector<HTMLElement>(".lc-tweak-header");
		if (!header) return;
		let startX = 0;
		let startY = 0;
		let originLeft = 0;
		let originTop = 0;
		let dragging = false;

		const onMove = (e: MouseEvent) => {
			if (!dragging) return;
			const maxLeft = window.innerWidth - 80;
			const maxTop = window.innerHeight - 40;
			this.el.style.left = `${Math.min(Math.max(originLeft + e.clientX - startX, -240), maxLeft)}px`;
			this.el.style.top = `${Math.min(Math.max(originTop + e.clientY - startY, 0), maxTop)}px`;
			this.el.style.right = "auto";
		};
		const onUp = () => {
			dragging = false;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		header.addEventListener("mousedown", (e: MouseEvent) => {
			if ((e.target as HTMLElement).closest("button")) return;
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			const rect = this.el.getBoundingClientRect();
			originLeft = rect.left;
			originTop = rect.top;
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
			e.preventDefault();
		});
	}
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
			text: "Connect a free Supabase project to sync your Vision, Goals, and Quarter across devices in real time. Leave blank to use this device only.",
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
			text: "Now that Vision/Goals/Quarters aren't stored as notes, the only durable copy besides Supabase is this device's local plugin data. Export a snapshot into the vault (backed up the same way the rest of your notes are) as a safety net.",
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
type Tab = "overview" | "vision" | "outcomes" | "quarter" | "trends";

// A guided first-run tour across tabs, in the spirit of Habit Tracker's own
// walkthrough — but since each tab's content is torn down and rebuilt on
// switch (not one always-mounted form), each step names which tab it needs
// and the tour drives tab switches itself between steps rather than
// assuming everything's already on screen.
interface WalkthroughStep {
	tab: Tab;
	title: string;
	body: string;
	targetSelector: string;
}

const WALKTHROUGH_STEPS: WalkthroughStep[] = [
	{
		tab: "overview",
		title: "Welcome to Life Compass",
		body: "This is built around RPM: Vision (your Purpose) → Goals (the Results you're after) → Quarter (the Massive Action Plan that actually gets you there). This tour walks through each in order — Skip any time.",
		targetSelector: ".lc-tab-row",
	},
	{
		tab: "vision",
		title: "Start with Vision",
		body: "Rate each life area 1-10, then write its Purpose (why it matters) and a vivid future (what it looks like 3-5 years from now, as if it's already true). Numbers alone aren't a vision — the writing is what makes it real.",
		targetSelector: ".lc-wheel-row",
	},
	{
		tab: "outcomes",
		title: "Turn Vision into Goals",
		body: "A Goal ladders up to one Vision category — a concrete Result with a Success Metric and a deadline. It can't go Active until it's linked to at least one Habit Tracker habit — that's the System that actually drives it.",
		targetSelector: ".lc-add-btn",
	},
	{
		tab: "quarter",
		title: "This quarter's ONE Priority",
		body: "Every quarter auto-generates with real dates. Set the one Wildly Important Goal, break it into Monthly Milestones, and check off your Weekly Commitments and Daily Actions — the Massive Action Plan — as you go.",
		targetSelector: ".lc-quarter-header, .lc-add-btn",
	},
	{
		tab: "overview",
		title: "Overview is home",
		body: "Come back here first. Every card is clickable — jump straight into whichever tab needs attention — and Momentum shows what's actually working, not just what's still outstanding.",
		targetSelector: ".lc-overview-card",
	},
];

class LifeCompassView extends ItemView {
	plugin: LifeCompassPlugin;
	activeTab: Tab = "overview";
	walkthroughStep = -1; // -1 = inactive
	private walkthroughEls: { backdrop: HTMLElement; tooltip: HTMLElement } | null = null;

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

	async onClose() {
		this.walkthroughEls?.backdrop.remove();
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("lc-view-root");
		// Design Tweaks land here as inline custom properties, same pattern
		// as Habit Tracker's own applyTweaksTo — re-applied on every render
		// so a saved tweak reshapes the pane every time it redraws, not just
		// once at load.
		applyTweaksTo(root, this.plugin.settings.designTweaks);

		const tabRow = root.createDiv({ cls: "lc-tab-row" });
		const tabs: { id: Tab; label: string }[] = [
			{ id: "overview", label: "🏠 Overview" },
			{ id: "vision", label: "🎯 Vision" },
			{ id: "outcomes", label: "🚀 Goals" },
			{ id: "quarter", label: "📅 Quarter" },
			{ id: "trends", label: "📈 Trends" },
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

		const walkthroughBtn = tabRow.createEl("button", { text: "🎓 Walkthrough", cls: "lc-walkthrough-btn" });
		walkthroughBtn.type = "button";
		walkthroughBtn.onclick = () => this.startWalkthrough();

		const body = root.createDiv({ cls: "lc-tab-body" });
		if (this.activeTab === "overview") this.renderOverview(body);
		else if (this.activeTab === "vision") this.renderVision(body);
		else if (this.activeTab === "outcomes") this.renderOutcomes(body);
		else if (this.activeTab === "quarter") this.renderQuarter(body);
		else this.renderTrends(body);

		if (this.walkthroughStep >= 0) this.showWalkthroughStep(body);
	}

	startWalkthrough() {
		this.walkthroughStep = 0;
		this.activeTab = WALKTHROUGH_STEPS[0].tab;
		this.render();
	}

	endWalkthrough() {
		this.walkthroughStep = -1;
		this.walkthroughEls?.backdrop.remove();
		this.walkthroughEls = null;
		this.render();
	}

	// Renders (or re-renders, on Next/Back) the spotlight + tooltip for the
	// current step, targeting an element within the tab body that was just
	// built by render() above. A fixed-position overlay appended to <body>
	// (same pattern as Habit Tracker's settings backdrop) rather than
	// anchored inside the pane, since this is a full ItemView, not a modal —
	// no scroll-clipping concerns to work around here.
	showWalkthroughStep(body: HTMLElement) {
		this.walkthroughEls?.backdrop.remove();

		const step = WALKTHROUGH_STEPS[this.walkthroughStep];
		const target = body.querySelector<HTMLElement>(step.targetSelector) ?? body;
		target.addClass("lc-walkthrough-highlight");
		target.scrollIntoView({ block: "center", behavior: "smooth" });

		const backdrop = document.body.createDiv({ cls: "lc-walkthrough-tooltip-backdrop" });
		const tooltip = backdrop.createDiv({ cls: "lc-walkthrough-tooltip" });
		tooltip.createDiv({ text: `Step ${this.walkthroughStep + 1} of ${WALKTHROUGH_STEPS.length}`, cls: "lc-walkthrough-progress" });
		tooltip.createEl("strong", { text: step.title, cls: "lc-walkthrough-title" });
		tooltip.createEl("p", { text: step.body, cls: "lc-walkthrough-body" });

		const btnRow = tooltip.createDiv({ cls: "lc-walkthrough-btns" });
		const skipBtn = btnRow.createEl("button", { text: "Skip", cls: "lc-walkthrough-skip" });
		skipBtn.type = "button";
		skipBtn.onclick = () => this.endWalkthrough();

		if (this.walkthroughStep > 0) {
			const backBtn = btnRow.createEl("button", { text: "Back" });
			backBtn.type = "button";
			backBtn.onclick = () => {
				this.walkthroughStep--;
				this.activeTab = WALKTHROUGH_STEPS[this.walkthroughStep].tab;
				this.render();
			};
		}

		const isLast = this.walkthroughStep === WALKTHROUGH_STEPS.length - 1;
		const nextBtn = btnRow.createEl("button", { text: isLast ? "Got it" : "Next", cls: "mod-cta" });
		nextBtn.type = "button";
		nextBtn.onclick = () => {
			if (isLast) {
				this.endWalkthrough();
				return;
			}
			this.walkthroughStep++;
			this.activeTab = WALKTHROUGH_STEPS[this.walkthroughStep].tab;
			this.render();
		};

		window.setTimeout(() => {
			const targetRect = target.getBoundingClientRect();
			const maxLeft = Math.max(8, window.innerWidth - tooltip.offsetWidth - 8);
			tooltip.style.left = `${Math.min(Math.max(8, targetRect.left), maxLeft)}px`;
			const belowTop = targetRect.bottom + 12;
			const fitsBelow = belowTop + tooltip.offsetHeight < window.innerHeight - 8;
			tooltip.style.top = `${fitsBelow ? belowTop : Math.max(8, targetRect.top - tooltip.offsetHeight - 12)}px`;
		}, 260);

		this.walkthroughEls = { backdrop, tooltip };
	}

	// ---- Vision tab ----
	// ---- Overview tab: a glance across all three tabs, since previously
	// there was no way to see wheel + quarter + outcomes at once. ----
	renderOverview(body: HTMLElement) {
		body.addClass("lc-overview-root");

		const ratings = this.plugin.data.categories.map((c) => this.plugin.data.vision[c.key]?.rating ?? 0).filter((r) => r > 0);
		const avgRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—";
		const visionCard = body.createDiv({ cls: "lc-overview-card" });
		makeCardClickable(visionCard, () => {
			this.activeTab = "vision";
			this.render();
		});
		visionCard.createDiv({ text: copyText(this.plugin.settings.designCopy, "overview.visionLabel"), cls: "lc-field-label" });
		visionCard.createDiv({
			text: ratings.length ? `Average satisfaction: ${avgRating} / 10 across ${ratings.length} rated categories` : "No categories rated yet.",
			cls: "lc-outcome-metric",
		});

		const missingVision = this.plugin.data.categories.filter(
			(c) => !this.plugin.data.vision[c.key]?.prose?.trim() && !this.plugin.data.vision[c.key]?.purpose?.trim()
		);
		if (missingVision.length) {
			const nudge = body.createDiv({ cls: "lc-overview-card lc-vision-nudge" });
			nudge.createDiv({ text: copyText(this.plugin.settings.designCopy, "overview.visionNudgeLabel"), cls: "lc-field-label" });
			nudge.createDiv({
				text: `${missingVision.length} of ${this.plugin.data.categories.length} categories have a rating but no Purpose or Vivid-Future written yet. Numbers alone aren't a vision.`,
				cls: "lc-outcome-metric",
			});
			const chipRow = nudge.createDiv({ cls: "lc-vision-nudge-chips" });
			for (const cat of missingVision) {
				const chip = chipRow.createEl("button", { text: cat.label, cls: "lc-vision-nudge-chip" });
				chip.type = "button";
				chip.onclick = () => {
					this.activeTab = "vision";
					this.render();
				};
			}
		}

		const current = this.plugin.data.quarters.find((q) => q.id === this.plugin.data.currentQuarterId);
		const quarterCard = body.createDiv({ cls: "lc-overview-card" });
		makeCardClickable(quarterCard, () => {
			this.activeTab = "quarter";
			this.render();
		});
		quarterCard.createDiv({ text: copyText(this.plugin.settings.designCopy, "overview.quarterLabel"), cls: "lc-field-label" });
		if (current) {
			quarterCard.createDiv({ text: current.id, cls: "lc-outcome-title" });
			// The Priority is the single most important sentence in the app —
			// the one Wildly Important Goal everything else ladders up to —
			// so it gets real visual weight here instead of blending in with
			// every other stat line on this tab.
			if (current.priority) quarterCard.createDiv({ text: current.priority, cls: "lc-overview-priority" });
			if (current.deadline) quarterCard.createDiv({ text: daysUntil(current.deadline), cls: "lc-outcome-deadline" });
		} else {
			quarterCard.createDiv({ text: copyText(this.plugin.settings.designCopy, "overview.noActiveQuarter"), cls: "lc-outcomes-empty" });
		}

		const outcomes = this.plugin.data.outcomes.filter((o) => !o.archived);
		const outcomesCard = body.createDiv({ cls: "lc-overview-card" });
		makeCardClickable(outcomesCard, () => {
			this.activeTab = "outcomes";
			this.render();
		});
		outcomesCard.createDiv({ text: copyText(this.plugin.settings.designCopy, "overview.goalsLabel"), cls: "lc-field-label" });
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
			bar.toggleClass("lc-progress-bar-near-complete", (o.progress ?? 0) >= 75);
			progressWrap.createSpan({ text: `${o.progress ?? 0}%`, cls: "lc-progress-label" });
		}

		// ---- Momentum: proof of progress already made, not what's still
		// outstanding — pride/motivation register, the counterpart to Habit
		// Tracker's own streak-at-risk pressure register. ----
		const habits = getHabitTrackerHabits(this.plugin.app);
		const linkedHabitIds = new Set(outcomes.reduce<string[]>((acc, o) => acc.concat(o.linkedHabitIds ?? []), []));
		const topStreaks = (habits ?? [])
			.filter((h) => linkedHabitIds.has(h.id))
			.map((h) => ({ name: h.name, streak: getHabitStreak(this.plugin.app, h.id) }))
			.filter((h) => h.streak > 0)
			.sort((a, b) => b.streak - a.streak)
			.slice(0, 3);

		const ratingDeltas = this.plugin.data.categories
			.map((cat) => {
				const points = this.plugin.data.ratingHistory
					.filter((e) => e.categoryKey === cat.key)
					.sort((a, b) => a.date.localeCompare(b.date));
				if (points.length < 2) return null;
				const delta = points[points.length - 1].rating - points[0].rating;
				return delta !== 0 ? { label: cat.label, delta, from: points[0].rating, to: points[points.length - 1].rating } : null;
			})
			.filter((d): d is { label: string; delta: number; from: number; to: number } => d !== null);

		const hasMomentum = topStreaks.length > 0 || (current && milestoneProgress(current).done > 0) || (current && checkinStreak(current) > 0) || ratingDeltas.length > 0;
		if (hasMomentum) {
			const momentumCard = body.createDiv({ cls: "lc-overview-card lc-momentum-card" });
			momentumCard.createDiv({ text: copyText(this.plugin.settings.designCopy, "overview.momentumLabel"), cls: "lc-field-label" });
			for (const s of topStreaks) {
				momentumCard.createDiv({ text: `🔥 ${s.streak}-day streak on ${s.name}`, cls: "lc-momentum-line" });
			}
			if (current) {
				const { done: milestonesDone, total: milestonesTotal } = milestoneProgress(current);
				if (milestonesDone > 0) {
					momentumCard.createDiv({ text: `🏁 ${milestonesDone}/${milestonesTotal} milestones done this quarter`, cls: "lc-momentum-line" });
				}
				const streak = checkinStreak(current);
				if (streak > 0) {
					momentumCard.createDiv({ text: `📈 ${streak}-day check-in streak this quarter`, cls: "lc-momentum-line" });
				}
			}
			for (const d of ratingDeltas) {
				momentumCard.createDiv({
					text: `${d.delta > 0 ? "⬆️" : "⬇️"} ${d.label}: ${d.from}→${d.to}, ${d.delta > 0 ? "up" : "down"} ${Math.abs(d.delta)}`,
					cls: "lc-momentum-line",
				});
			}
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
		for (const cat of this.plugin.data.categories) {
			const row = list.createDiv({ cls: "lc-wheel-row" });
			row.style.setProperty("--lc-cat-color", categoryColor(this.plugin.data.categories, cat.key));
			const labelRow = row.createDiv({ cls: "lc-wheel-row-label-row" });
			labelRow.createDiv({ text: cat.label, cls: "lc-wheel-row-label" });
			if (this.plugin.data.categories.length > 1) {
				const removeBtn = labelRow.createEl("button", { text: "×", cls: "lc-milestone-remove" });
				removeBtn.type = "button";
				removeBtn.setAttr("aria-label", `Remove ${cat.label}`);
				removeBtn.onclick = () => {
					const linked = this.plugin.data.outcomes.filter((o) => !o.archived && o.visionCategory === cat.key);
					if (linked.length) {
						new Notice(`Can't remove "${cat.label}" — still linked from: ${linked.map((o) => o.name).join(", ")}. Reassign or archive those Goals first.`);
						return;
					}
					new ConfirmDeleteModal(this.plugin.app, cat.label, async () => {
						this.plugin.data.categories = this.plugin.data.categories.filter((c) => c.key !== cat.key);
						delete this.plugin.data.vision[cat.key];
						await this.plugin.persist();
						this.render();
					}).open();
				};
			}

			const hasVision = !!(this.plugin.data.vision[cat.key]?.prose?.trim() || this.plugin.data.vision[cat.key]?.purpose?.trim());
			row.toggleClass("lc-wheel-row-needs-vision", !hasVision);

			const ratingRow = row.createDiv({ cls: "lc-wheel-rating-buttons" });
			const current = this.plugin.data.vision[cat.key]?.rating ?? 0;
			const buttons: HTMLButtonElement[] = [];
			for (let n = 1; n <= 10; n++) {
				const btn = ratingRow.createEl("button", { text: "" + n, cls: "lc-rating-btn" + (n === current ? " lc-rating-btn-filled" : "") });
				btn.type = "button";
				btn.setAttr("aria-label", `Rate ${cat.label} ${n} out of 10`);
				buttons.push(btn);
				btn.onclick = async () => {
					const wasSelected = this.plugin.data.vision[cat.key].rating === n;
					const next = wasSelected ? 0 : n;
					this.plugin.data.vision[cat.key].rating = next;
					recordRatingHistory(this.plugin.data, cat.key, next);
					await this.plugin.persist();
					buttons.forEach((b, i) => b.toggleClass("lc-rating-btn-filled", i + 1 === next));
					redrawChart();
				};
			}

			const labelWrap = row.createDiv({ cls: "lc-field-label-row" });
			labelWrap.createDiv({ text: "Purpose — why this matters", cls: "lc-field-label" });
			if (!hasVision) labelWrap.createSpan({ text: "Not yet written", cls: "lc-vision-not-written-badge" });
			const purpose = row.createEl("textarea", { cls: "lc-textarea lc-wheel-row-prose-input" });
			purpose.rows = 2;
			purpose.placeholder = "Why does this life area matter to you? What's it in service of?";
			purpose.value = this.plugin.data.vision[cat.key]?.purpose ?? "";
			purpose.setAttr("aria-label", `${cat.label} purpose`);
			purpose.onblur = async () => {
				const changed = purpose.value !== (this.plugin.data.vision[cat.key]?.purpose ?? "");
				this.plugin.data.vision[cat.key].purpose = purpose.value;
				await this.plugin.persist();
				if (changed) flashSaved(purpose);
			};

			row.createDiv({ text: "Vivid future — 3-5 years from now, as if it's already true", cls: "lc-field-label" });
			const prose = row.createEl("textarea", { cls: "lc-textarea lc-wheel-row-prose-input" });
			prose.rows = 3;
			prose.placeholder = "Describe this life area 3-5 years from now, exactly how you want it — sights, feelings, specifics.";
			prose.value = this.plugin.data.vision[cat.key]?.prose ?? "";
			prose.setAttr("aria-label", `${cat.label} vivid future`);
			prose.onblur = async () => {
				const changed = prose.value !== (this.plugin.data.vision[cat.key]?.prose ?? "");
				this.plugin.data.vision[cat.key].prose = prose.value;
				await this.plugin.persist();
				if (changed) flashSaved(prose);
			};
		}

		const addRow = body.createDiv({ cls: "lc-milestone-add-group" });
		const addInput = addRow.createEl("input", { cls: "lc-inline-input" });
		addInput.placeholder = "New life area, e.g. Spirituality";
		addInput.setAttr("aria-label", "New life area name");
		const addBtn = addRow.createEl("button", { text: "+ Add Life Area" });
		addBtn.type = "button";
		const submit = async () => {
			const label = addInput.value.trim();
			if (!label) return;
			const key = uniqueCategoryKey(this.plugin.data.categories, label);
			this.plugin.data.categories.push({ key, label });
			this.plugin.data.vision[key] = { rating: 0, prose: "" };
			await this.plugin.persist();
			this.render();
		};
		addBtn.onclick = submit;
		addInput.onkeydown = (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		};
	}

	buildChart(): SVGSVGElement {
		const size = 320;
		const center = size / 2;
		const maxRadius = size / 2 - 48;
		const categories = this.plugin.data.categories;
		const n = categories.length;
		const svgNs = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNs, "svg") as unknown as SVGSVGElement;
		// Extra horizontal room so axis labels like "Personal Growth" don't clip against the viewBox edge.
		const hPad = 55;
		svg.setAttribute("viewBox", `${-hPad} 0 ${size + hPad * 2} ${size}`);
		svg.addClass("lc-wheel-chart");

		const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
		const pointAt = (i: number, radius: number) => {
			const a = angleFor(i);
			return [center + Math.cos(a) * radius, center + Math.sin(a) * radius];
		};

		for (let ring = 2; ring <= 10; ring += 2) {
			const r = (ring / 10) * maxRadius;
			const points = categories.map((_, i) => pointAt(i, r).join(",")).join(" ");
			const poly = document.createElementNS(svgNs, "polygon");
			poly.setAttribute("points", points);
			poly.addClass("lc-wheel-grid-ring");
			svg.appendChild(poly);
		}

		categories.forEach((cat, i) => {
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

		const dataPoints = categories.map((cat, i) => pointAt(i, ((this.plugin.data.vision[cat.key]?.rating ?? 0) / 10) * maxRadius).join(","))
			.join(" ");
		const dataPoly = document.createElementNS(svgNs, "polygon");
		dataPoly.setAttribute("points", dataPoints);
		dataPoly.addClass("lc-wheel-data-poly");
		svg.appendChild(dataPoly);

		categories.forEach((cat, i) => {
			const value = this.plugin.data.vision[cat.key]?.rating ?? 0;
			if (!value) return;
			const [x, y] = pointAt(i, (value / 10) * maxRadius);
			const dot = document.createElementNS(svgNs, "circle");
			dot.setAttribute("cx", "" + x);
			dot.setAttribute("cy", "" + y);
			dot.setAttribute("r", "4");
			dot.addClass("lc-wheel-data-dot");
			dot.style.setProperty("--lc-cat-color", categoryColor(categories, cat.key));
			svg.appendChild(dot);

			const [lx, ly] = pointAt(i, (value / 10) * maxRadius + 14);
			const valueLabel = document.createElementNS(svgNs, "text");
			valueLabel.setAttribute("x", "" + lx);
			valueLabel.setAttribute("y", "" + ly);
			valueLabel.setAttribute("text-anchor", "middle");
			valueLabel.setAttribute("dominant-baseline", "middle");
			valueLabel.addClass("lc-wheel-data-value");
			valueLabel.style.setProperty("--lc-cat-color", categoryColor(categories, cat.key));
			valueLabel.textContent = "" + value;
			svg.appendChild(valueLabel);
		});

		return svg;
	}

	// ---- Trends tab: line charts over ratingHistory/progressHistory, since
	// the Vision wheel and Outcome cards only ever show current-state
	// snapshots — this is the only place to see whether anything is
	// actually moving. Reuses the hand-built SVG approach from buildChart()
	// rather than pulling in a charting library. ----
	renderTrends(body: HTMLElement) {
		body.addClass("lc-trends-root");

		body.createEl("h3", { text: "🎯 Vision ratings over time" });
		if (this.plugin.data.ratingHistory.length === 0) {
			body.createDiv({
				text: "Come back after your first few rating changes — trends build up over time.",
				cls: "lc-outcomes-empty",
			});
		} else {
			const categories = this.plugin.data.categories;
			const series = categories.map((cat) => ({
				label: cat.label,
				color: categoryColor(categories, cat.key),
				points: this.plugin.data.ratingHistory
					.filter((e) => e.categoryKey === cat.key)
					.sort((a, b) => a.date.localeCompare(b.date))
					.map((e) => ({ date: e.date, value: e.rating })),
			})).filter((s) => s.points.length > 0);
			body.appendChild(this.buildLineChart(series, 0, 10));
		}

		body.createEl("h3", { text: "🚀 Goal progress over time" });
		const activeOutcomes = this.plugin.data.outcomes.filter((o) => !o.archived);
		const outcomesWithHistory = activeOutcomes.filter((o) => this.plugin.data.progressHistory.some((e) => e.outcomeId === o.id));
		if (outcomesWithHistory.length === 0) {
			body.createDiv({
				text: "Once you update a Goal's progress a few times, its trend line will show up here.",
				cls: "lc-outcomes-empty",
			});
		} else {
			const series = outcomesWithHistory.map((o, i) => ({
				label: o.name,
				color: categoryColor(this.plugin.data.categories, o.visionCategory) || CATEGORY_COLORS[i % CATEGORY_COLORS.length],
				points: this.plugin.data.progressHistory
					.filter((e) => e.outcomeId === o.id)
					.sort((a, b) => a.date.localeCompare(b.date))
					.map((e) => ({ date: e.date, value: e.progress })),
			}));
			body.appendChild(this.buildLineChart(series, 0, 100));
		}
	}

	// A small multi-series line chart — shared x-axis of every distinct date
	// across all series, y from minY to maxY. Same SVG-building conventions
	// (svgNs, viewBox padding, .addClass styling) as buildChart() above.
	buildLineChart(series: { label: string; color: string; points: { date: string; value: number }[] }[], minY: number, maxY: number): SVGSVGElement {
		const width = 640;
		const height = 260;
		const padL = 36;
		const padR = 16;
		const padT = 16;
		const padB = 28;
		const svgNs = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(svgNs, "svg") as unknown as SVGSVGElement;
		svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
		svg.addClass("lc-trend-chart");

		const dates = Array.from(new Set(series.reduce<string[]>((acc, s) => acc.concat(s.points.map((p) => p.date)), []))).sort();
		if (dates.length === 0) return svg;

		const xFor = (date: string) => {
			const i = dates.indexOf(date);
			return dates.length === 1 ? padL : padL + (i / (dates.length - 1)) * (width - padL - padR);
		};
		const yFor = (value: number) => height - padB - ((value - minY) / (maxY - minY)) * (height - padT - padB);

		// Gridlines
		for (let g = 0; g <= 4; g++) {
			const value = minY + (g / 4) * (maxY - minY);
			const y = yFor(value);
			const line = document.createElementNS(svgNs, "line");
			line.setAttribute("x1", "" + padL);
			line.setAttribute("y1", "" + y);
			line.setAttribute("x2", "" + (width - padR));
			line.setAttribute("y2", "" + y);
			line.addClass("lc-trend-grid-line");
			svg.appendChild(line);
			const label = document.createElementNS(svgNs, "text");
			label.setAttribute("x", "" + (padL - 6));
			label.setAttribute("y", "" + y);
			label.setAttribute("text-anchor", "end");
			label.setAttribute("dominant-baseline", "middle");
			label.addClass("lc-trend-axis-label");
			label.textContent = "" + Math.round(value);
			svg.appendChild(label);
		}

		for (const s of series) {
			if (s.points.length === 0) continue;
			const linePoints = s.points.map((p) => `${xFor(p.date)},${yFor(p.value)}`).join(" ");
			if (s.points.length > 1) {
				const line = document.createElementNS(svgNs, "polyline");
				line.setAttribute("points", linePoints);
				line.setAttribute("fill", "none");
				line.addClass("lc-trend-line");
				line.style.setProperty("--lc-trend-color", s.color);
				svg.appendChild(line);
			}
			for (const p of s.points) {
				const dot = document.createElementNS(svgNs, "circle");
				dot.setAttribute("cx", "" + xFor(p.date));
				dot.setAttribute("cy", "" + yFor(p.value));
				dot.setAttribute("r", "3");
				dot.addClass("lc-trend-dot");
				dot.style.setProperty("--lc-trend-color", s.color);
				svg.appendChild(dot);
			}
			const last = s.points[s.points.length - 1];
			const endLabel = document.createElementNS(svgNs, "text");
			endLabel.setAttribute("x", "" + (xFor(last.date) + 6));
			endLabel.setAttribute("y", "" + yFor(last.value));
			endLabel.setAttribute("dominant-baseline", "middle");
			endLabel.addClass("lc-trend-end-label");
			endLabel.style.setProperty("--lc-trend-color", s.color);
			endLabel.textContent = s.label;
			svg.appendChild(endLabel);
		}

		return svg;
	}

	// ---- Outcomes tab ----
	renderOutcomes(body: HTMLElement) {
		body.addClass("lc-outcomes-root");

		const addBtn = body.createEl("button", { text: copyText(this.plugin.settings.designCopy, "goals.addButton"), cls: "lc-add-btn" });
		addBtn.type = "button";
		addBtn.onclick = () => new OutcomeFormModal(this.plugin, null, () => this.render()).open();

		if (this.plugin.data.outcomes.length === 0) {
			body.createDiv({ text: copyText(this.plugin.settings.designCopy, "goals.emptyState"), cls: "lc-outcomes-empty" });
			return;
		}

		const habits = getHabitTrackerHabits(this.plugin.app);
		const active = this.plugin.data.outcomes.filter((o) => !o.archived);
		const archived = this.plugin.data.outcomes.filter((o) => o.archived);

		if (active.length === 0) {
			body.createDiv({ text: copyText(this.plugin.settings.designCopy, "goals.emptyActiveState"), cls: "lc-outcomes-empty" });
		} else {
			const grid = body.createDiv({ cls: "lc-outcomes-grid" });
			for (const outcome of active) this.renderOutcomeCard(grid, outcome, habits, false);
		}

		if (archived.length) {
			const section = body.createDiv({ cls: "lc-quarter-section" });
			const toggle = section.createEl("h4", { text: `▸ Archived Goals (${archived.length})`, cls: "lc-collapsible-toggle" });
			const list = section.createDiv({ cls: "lc-collapsible-body lc-outcomes-grid" });
			toggle.onclick = () => {
				const nowOpen = !list.hasClass("lc-collapsible-body-open");
				list.toggleClass("lc-collapsible-body-open", nowOpen);
				toggle.setText(`${nowOpen ? "▾" : "▸"} Archived Goals (${archived.length})`);
			};
			for (const outcome of archived) this.renderOutcomeCard(list, outcome, habits, true);
		}
	}

	renderOutcomeCard(container: HTMLElement, outcome: Outcome, habits: LinkedHabitLite[] | null, archived: boolean) {
		const card = container.createDiv({ cls: "lc-outcome-card" });
		card.style.setProperty("--lc-outcome-color", categoryColor(this.plugin.data.categories, outcome.visionCategory));

		const header = card.createDiv({ cls: "lc-outcome-header" });
		header.createDiv({ text: outcome.name, cls: "lc-outcome-title" });
		header.createSpan({ text: outcome.status, cls: "lc-outcome-status lc-outcome-status-" + outcome.status });

		const catLabel = this.plugin.data.categories.find((c) => c.key === outcome.visionCategory)?.label;
		if (catLabel) card.createDiv({ text: catLabel, cls: "lc-outcome-category" });

		// The Quarter tab already shows "Ladders up to: <Outcome name>" —
		// this is the reverse direction, so the connection reads both ways
		// instead of only from Quarter→Outcome.
		const currentQuarter = this.plugin.data.quarters.find((q) => q.id === this.plugin.data.currentQuarterId);
		if (currentQuarter && currentQuarter.outcomeId === outcome.id) {
			card.createDiv({ text: `🧭 Currently worked on in ${currentQuarter.id}`, cls: "lc-outcome-current-quarter-badge" });
		}

		if (outcome.successMetric) card.createDiv({ text: outcome.successMetric, cls: "lc-outcome-metric" });
		if (outcome.startDate) {
			const d = new Date(outcome.startDate);
			const formatted = Number.isNaN(d.getTime())
				? outcome.startDate
				: d.toLocaleDateString("default", { month: "short", day: "numeric", year: "numeric" });
			card.createDiv({ text: `Started: ${formatted}`, cls: "lc-outcome-start-date" });
		}
		if (outcome.deadline) card.createDiv({ text: `Achieve by: ${daysUntil(outcome.deadline)}`, cls: "lc-outcome-deadline" });
		if (outcome.why) card.createDiv({ text: `Why: ${outcome.why}`, cls: "lc-outcome-why" });
		if (outcome.baseline) card.createDiv({ text: `Baseline: ${outcome.baseline}`, cls: "lc-outcome-obstacles" });
		if (outcome.obstacles) card.createDiv({ text: `Obstacles: ${outcome.obstacles}`, cls: "lc-outcome-obstacles" });

		const progressWrap = card.createDiv({ cls: "lc-progress-wrap" });
		const progressTrack = progressWrap.createDiv({ cls: "lc-progress-track" });
		const progressBar = progressTrack.createDiv({ cls: "lc-progress-bar" });
		progressBar.style.width = `${Math.max(0, Math.min(100, outcome.progress ?? 0))}%`;
		progressBar.toggleClass("lc-progress-bar-near-complete", (outcome.progress ?? 0) >= 75);
		progressWrap.createSpan({ text: `${outcome.progress ?? 0}%`, cls: "lc-progress-label" });

		const linkedQuarterIds = this.plugin.data.quarters.filter((q) => q.outcomeId === outcome.id).map((q) => q.id.toLowerCase());
		const matchNames = new Set([outcome.name.toLowerCase(), ...linkedQuarterIds]);
		const explicitIds = new Set(outcome.linkedHabitIds ?? []);
		const linkedHabits = (habits ?? []).filter(
			(h) => explicitIds.has(h.id) || (h.linkedGoal && matchNames.has(h.linkedGoal.trim().toLowerCase()))
		);

		if (linkedHabits.length) {
			const systemEl = card.createDiv({ cls: "lc-outcome-system" });
			systemEl.createDiv({ text: copyText(this.plugin.settings.designCopy, "goals.systemLabel"), cls: "lc-outcome-system-label" });
			for (const h of linkedHabits) {
				const row = systemEl.createDiv({ cls: "lc-outcome-habit-row" });
				const dot = row.createSpan({ cls: "lc-outcome-habit-dot" });
				dot.style.backgroundColor = h.color;
				row.createSpan({ text: h.name, cls: "lc-outcome-habit-name" });
				row.createSpan({ text: `🔥 ${getHabitStreak(this.plugin.app, h.id)}`, cls: "lc-outcome-habit-streak" });
			}
		} else if (habits) {
			card.createDiv({ text: copyText(this.plugin.settings.designCopy, "goals.systemEmpty"), cls: "lc-outcome-system-empty" });
		}

		const actions = card.createDiv({ cls: "lc-outcome-actions" });
		if (archived) {
			const restoreBtn = actions.createEl("button", { text: "↩️", cls: "lc-icon-btn" });
			restoreBtn.type = "button";
			restoreBtn.setAttr("aria-label", "Restore goal");
			restoreBtn.onclick = async (e) => {
				e.stopPropagation();
				outcome.archived = false;
				outcome.updatedAt = todayStr();
				await this.plugin.persist();
				this.render();
			};
		} else {
			const archiveBtn = actions.createEl("button", { text: "📦", cls: "lc-icon-btn" });
			archiveBtn.type = "button";
			archiveBtn.setAttr("aria-label", "Archive goal");
			archiveBtn.onclick = async (e) => {
				e.stopPropagation();
				outcome.archived = true;
				outcome.updatedAt = todayStr();
				await this.plugin.persist();
				this.render();
			};
		}
		const editBtn = actions.createEl("button", { text: "✏️", cls: "lc-icon-btn" });
		editBtn.type = "button";
		editBtn.setAttr("aria-label", "Edit goal");
		editBtn.onclick = (e) => {
			e.stopPropagation();
			new OutcomeFormModal(this.plugin, outcome, () => this.render()).open();
		};
		const delBtn = actions.createEl("button", { text: "🗑", cls: "lc-icon-btn" });
		delBtn.type = "button";
		delBtn.setAttr("aria-label", "Delete goal");
		delBtn.onclick = (e) => {
			e.stopPropagation();
			new ConfirmDeleteModal(this.plugin.app, outcome.name, async () => {
				this.plugin.data.outcomes = this.plugin.data.outcomes.filter((o) => o.id !== outcome.id);
				await this.plugin.persist();
				this.render();
			}).open();
		};
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
		const range = formatQuarterRange(current);
		if (range) body.createDiv({ text: range, cls: "lc-outcome-category" });
		if (current.deadline) body.createDiv({ text: daysUntil(current.deadline), cls: "lc-outcome-deadline" });

		this.renderTextSection(body, "Priority — the ONE Wildly Important Goal", current.priority, async (v) => {
			current.priority = v;
			await this.plugin.persist();
		});
		this.renderTextSection(body, "Why", current.why, async (v) => {
			current.why = v;
			await this.plugin.persist();
		});
		this.renderTextSection(body, "Notes", current.notes ?? "", async (v) => {
			current.notes = v;
			await this.plugin.persist();
		});

		const milestonesWrap = body.createDiv();
		const redrawMilestones = () => {
			milestonesWrap.empty();
			this.renderMilestonesInto(milestonesWrap, current, redrawMilestones);
		};
		redrawMilestones();

		const systemSection = body.createDiv({ cls: "lc-quarter-section" });
		systemSection.createEl("h4", { text: "System — Massive Action Plan (MAP)" });
		systemSection.createEl("p", {
			cls: "setting-item-description",
			text: "RPM: the Result is the Priority above; this is the Massive Action Plan that actually gets you there.",
		});
		// Older saved data may still have these as a single string — migrate
		// in place on first render so the checklist UI below always has a
		// real array to work with, and persist so it stays migrated.
		if (!Array.isArray(current.weeklyCommitments)) {
			current.weeklyCommitments = normalizeActionItems(current.weeklyCommitments);
			this.plugin.persist();
		}
		if (!Array.isArray(current.dailyActionsPrompt)) {
			current.dailyActionsPrompt = normalizeActionItems(current.dailyActionsPrompt);
			this.plugin.persist();
		}
		const weeklyWrap = systemSection.createDiv();
		const redrawWeekly = () => {
			weeklyWrap.empty();
			this.renderActionChecklist(weeklyWrap, "Weekly Commitments", current.weeklyCommitments, redrawWeekly);
		};
		redrawWeekly();
		const dailyWrap = systemSection.createDiv();
		const redrawDaily = () => {
			dailyWrap.empty();
			this.renderActionChecklist(dailyWrap, "Daily Actions", current.dailyActionsPrompt, redrawDaily);
		};
		redrawDaily();

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
		textarea.onblur = async () => {
			const changed = textarea.value !== value;
			await onSave(textarea.value);
			if (changed) flashSaved(textarea);
		};
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

	// Weekly Commitments / Daily Actions — same MilestoneItem shape and
	// check-off interaction as Monthly Milestones' items, just a flat list
	// with no month grouping.
	renderActionChecklist(container: HTMLElement, label: string, items: MilestoneItem[], redraw: () => void) {
		container.createDiv({ text: label, cls: "lc-field-label" });

		const list = container.createDiv({ cls: "lc-milestone-items" });
		items.forEach((item, ii) => {
			const row = list.createDiv({ cls: "lc-milestone-item" });
			const cb = row.createEl("input", { cls: "lc-milestone-checkbox" });
			cb.type = "checkbox";
			cb.checked = item.done;
			cb.setAttr("aria-label", item.text);
			cb.onchange = async () => {
				item.done = cb.checked;
				await this.plugin.persist();
				if (item.done) row.addClass("lc-milestone-item-pop");
				redraw();
			};
			row.createSpan({ text: item.text, cls: "lc-milestone-item-text" + (item.done ? " lc-milestone-item-done" : "") });
			const delBtn = row.createEl("button", { text: "×", cls: "lc-milestone-remove" });
			delBtn.type = "button";
			delBtn.setAttr("aria-label", `Delete "${item.text}"`);
			delBtn.onclick = async () => {
				items.splice(ii, 1);
				await this.plugin.persist();
				redraw();
			};
		});

		const addRow = container.createDiv({ cls: "lc-milestone-add-row" });
		const addInput = addRow.createEl("input", { cls: "lc-inline-input" });
		addInput.placeholder = `Add a${label.startsWith("Weekly") ? " weekly commitment" : "n action"}…`;
		addInput.setAttr("aria-label", `Add to ${label}`);
		const addBtn = addRow.createEl("button", { text: "+", cls: "lc-icon-btn" });
		addBtn.type = "button";
		addBtn.setAttr("aria-label", "Add item");
		const submit = async () => {
			if (!addInput.value.trim()) return;
			items.push({ text: addInput.value.trim(), done: false });
			await this.plugin.persist();
			redraw();
		};
		addBtn.onclick = submit;
		addInput.onkeydown = (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
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
		// Quarters now auto-generate for the whole year up front, so this
		// list holds upcoming and already-elapsed quarters alike, not just
		// past ones — "Other Quarters" covers both honestly.
		const others = this.plugin.data.quarters.filter((q) => q.id !== currentId);
		if (!others.length) return;
		const section = container.createDiv({ cls: "lc-quarter-section" });
		const toggle = section.createEl("h4", { text: `▸ Other Quarters (${others.length})`, cls: "lc-collapsible-toggle" });
		const list = section.createDiv({ cls: "lc-collapsible-body" });
		toggle.onclick = () => {
			const nowOpen = !list.hasClass("lc-collapsible-body-open");
			list.toggleClass("lc-collapsible-body-open", nowOpen);
			toggle.setText(`${nowOpen ? "▾" : "▸"} Other Quarters (${others.length})`);
		};
		for (const q of others) {
			const outcome = this.plugin.data.outcomes.find((o) => o.id === q.outcomeId);
			const card = list.createDiv({ cls: "lc-quarter-past-card" });
			const header = card.createDiv({ cls: "lc-outcome-header" });
			header.createDiv({ text: q.id, cls: "lc-outcome-title" });
			header.createSpan({ text: q.status, cls: "lc-outcome-status lc-outcome-status-" + q.status });
			const range = formatQuarterRange(q);
			if (range) card.createDiv({ text: range, cls: "lc-outcome-category" });
			if (q.priority) card.createDiv({ text: q.priority, cls: "lc-outcome-metric" });
			if (outcome) card.createDiv({ text: `Ladders up to: ${outcome.name}`, cls: "lc-outcome-category" });
			const actions = card.createDiv({ cls: "lc-outcome-actions lc-quarter-past-actions" });
			const makeCurrentBtn = actions.createEl("button", { text: "→ Make current", cls: "lc-icon-btn" });
			makeCurrentBtn.type = "button";
			makeCurrentBtn.setAttr("aria-label", `Make ${q.id} the current quarter`);
			makeCurrentBtn.onclick = async () => {
				const prevCurrent = this.plugin.data.quarters.find((qq) => qq.id === currentId);
				if (prevCurrent && prevCurrent.status === "active") {
					prevCurrent.status = "done";
					prevCurrent.updatedAt = todayStr();
				}
				this.plugin.data.currentQuarterId = q.id;
				await this.plugin.persist();
				this.render();
			};
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
					if (this.plugin.data.currentQuarterId === q.id) this.plugin.data.currentQuarterId = null;
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

// Shown at most once per Sunday evening (see maybeShowWeeklyDigest) — a
// quick look back at the week's habits plus where the current quarter
// stands, without having to open the full view.
class WeeklyDigestModal extends Modal {
	plugin: LifeCompassPlugin;

	constructor(plugin: LifeCompassPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("lc-modal");
		contentEl.createEl("h3", { text: "📊 Weekly Digest" });
		contentEl.createEl("p", {
			text: "How the week went — habits and where the current quarter stands.",
			cls: "setting-item-description",
		});

		// Omit this section entirely if Habit Tracker isn't installed/enabled,
		// same defensive pattern as the Outcome cards' linked-habits section.
		const habits = getHabitTrackerHabits(this.plugin.app);
		if (habits && habits.length) {
			const section = contentEl.createDiv({ cls: "lc-quarter-section" });
			section.createEl("h4", { text: "This week's habits" });
			const list = section.createDiv({ cls: "lc-digest-habit-list" });
			for (const h of habits) {
				const row = list.createDiv({ cls: "lc-outcome-habit-row" });
				const dot = row.createSpan({ cls: "lc-outcome-habit-dot" });
				dot.style.backgroundColor = h.color;
				row.createSpan({ text: h.name, cls: "lc-outcome-habit-name" });
				row.createSpan({ text: `${countWeeklyCompletions(this.plugin.app, h.id)}/7`, cls: "lc-outcome-habit-streak" });
			}
		}

		const current = this.plugin.data.quarters.find((q) => q.id === this.plugin.data.currentQuarterId);
		const quarterSection = contentEl.createDiv({ cls: "lc-quarter-section" });
		quarterSection.createEl("h4", { text: "Current Quarter" });
		if (current) {
			quarterSection.createDiv({ text: current.priority || "(No Priority set yet.)", cls: "lc-outcome-metric" });
			if (current.deadline) quarterSection.createDiv({ text: daysUntil(current.deadline), cls: "lc-outcome-deadline" });
			const { done, total } = milestoneProgress(current);
			quarterSection.createDiv({
				text: total ? `Monthly milestones: ${done}/${total} done` : "No monthly milestones added yet.",
				cls: "lc-outcome-metric",
			});
		} else {
			quarterSection.createDiv({ text: "No active quarter — open Life Compass to start one.", cls: "lc-outcomes-empty" });
		}

		const footer = contentEl.createDiv({ cls: "lc-modal-footer" });
		const openBtn = footer.createEl("button", { text: "Open Life Compass" });
		openBtn.type = "button";
		openBtn.onclick = () => {
			this.close();
			this.plugin.activateView();
		};
		const closeBtn = footer.createEl("button", { text: "Close", cls: "mod-cta" });
		closeBtn.type = "button";
		closeBtn.onclick = () => this.close();
	}
}

class OutcomeFormModal extends Modal {
	plugin: LifeCompassPlugin;
	existing: Outcome | null;
	onDone: () => void;
	values: {
		name: string;
		visionCategory: string;
		startDate: string;
		deadline: string;
		status: GoalStatus;
		successMetric: string;
		why: string;
		baseline: string;
		obstacles: string;
		progress: number;
	};
	// Mutable draft, same pattern as QuarterFormModal's checkinFieldsDraft
	// — not written to the Outcome until Save is clicked.
	linkedHabitIdsDraft: string[];

	constructor(plugin: LifeCompassPlugin, existing: Outcome | null, onDone: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.existing = existing;
		this.onDone = onDone;
		this.linkedHabitIdsDraft = existing ? [...(existing.linkedHabitIds ?? [])] : [];
		this.values = existing
			? {
					name: existing.name,
					visionCategory: existing.visionCategory,
					startDate: existing.startDate ?? "",
					deadline: existing.deadline,
					status: existing.status,
					successMetric: existing.successMetric,
					why: existing.why,
					baseline: existing.baseline ?? "",
					obstacles: existing.obstacles ?? "",
					progress: existing.progress ?? 0,
			  }
			: {
					name: "",
					visionCategory: plugin.data.categories[0]?.key ?? "",
					startDate: "",
					deadline: "",
					status: "active",
					successMetric: "",
					why: "",
					baseline: "",
					obstacles: "",
					progress: 0,
			  };
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("lc-modal");
		contentEl.addClass("lc-outcome-modal");
		contentEl.createEl("h3", { text: this.existing ? "Edit Goal" : "New Goal" });

		new Setting(contentEl).setName("Name").addText((t) => t.setValue(this.values.name).onChange((v) => (this.values.name = v)));
		const purposeRefEl = contentEl.createDiv({ cls: "setting-item-description lc-outcome-purpose-ref" });
		const renderPurposeRef = () => {
			const purpose = this.plugin.data.vision[this.values.visionCategory]?.purpose;
			purposeRefEl.setText(purpose ? `This category's Purpose: "${purpose}"` : "");
		};
		new Setting(contentEl).setName("Vision Category").addDropdown((dd) => {
			this.plugin.data.categories.forEach((c) => dd.addOption(c.key, c.label));
			dd.setValue(this.values.visionCategory).onChange((v) => {
				this.values.visionCategory = v;
				renderPurposeRef();
			});
		});
		renderPurposeRef();
		new Setting(contentEl).setName("Goal Start").addText((t) => {
			t.inputEl.type = "date";
			t.setValue(this.values.startDate).onChange((v) => (this.values.startDate = v));
		});
		new Setting(contentEl).setName("Achieve Goal By").addText((t) => {
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
			.setName("Why")
			.setDesc("Why this specific Goal matters — ideally it traces back to the category's Purpose above.")
			.addTextArea((t) => t.setValue(this.values.why).onChange((v) => (this.values.why = v)));
		new Setting(contentEl)
			.setName("Baseline (optional)")
			.addTextArea((t) => t.setValue(this.values.baseline).onChange((v) => (this.values.baseline = v)));
		new Setting(contentEl)
			.setName("Obstacles (optional)")
			.setDesc("What's likely to get in the way.")
			.addTextArea((t) => t.setValue(this.values.obstacles).onChange((v) => (this.values.obstacles = v)));
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

		contentEl.createEl("div", { text: "Linked habits", cls: "lc-field-label" });
		const habits = getHabitTrackerHabits(this.plugin.app);
		if (!habits) {
			contentEl.createEl("p", {
				text: "Habit Tracker isn't installed/enabled — install it to link habits here.",
				cls: "setting-item-description",
			});
		} else if (habits.length === 0) {
			contentEl.createEl("p", { text: "No habits yet in Habit Tracker.", cls: "setting-item-description" });
		} else {
			contentEl.createEl("p", {
				text: "Who do you need to become to hit this? This is the System that actually drives the Goal — check every habit or task that serves it.",
				cls: "setting-item-description",
			});
			const list = contentEl.createDiv({ cls: "lc-habit-picker" });
			for (const h of habits) {
				const row = list.createEl("label", { cls: "lc-habit-picker-row" });
				const cb = row.createEl("input");
				cb.type = "checkbox";
				cb.checked = this.linkedHabitIdsDraft.includes(h.id);
				cb.onchange = () => {
					if (cb.checked) {
						if (!this.linkedHabitIdsDraft.includes(h.id)) this.linkedHabitIdsDraft.push(h.id);
					} else {
						this.linkedHabitIdsDraft = this.linkedHabitIdsDraft.filter((id) => id !== h.id);
					}
				};
				const dot = row.createSpan({ cls: "lc-outcome-habit-dot" });
				dot.style.backgroundColor = h.color;
				row.createSpan({ text: h.name });
				if (h.kind === "task") {
					row.createSpan({ text: "TASK", cls: "lc-outcome-habit-task-badge" });
				}
			}
		}

		const footer = contentEl.createDiv({ cls: "lc-modal-footer" });
		const saveBtn = footer.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.type = "button";
		saveBtn.onclick = async () => {
			if (!this.values.name.trim()) {
				new Notice("Name is required.");
				return;
			}
			// You fall to the level of your systems — an Outcome can't go
			// Active without at least one habit or task actually driving it.
			if (this.values.status === "active" && this.linkedHabitIdsDraft.length === 0) {
				new Notice("Link at least one habit or task before marking this Goal Active — that's the System that actually drives it.");
				return;
			}
			const now = todayStr();
			if (this.existing) {
				this.existing.name = this.values.name.trim();
				this.existing.visionCategory = this.values.visionCategory;
				this.existing.startDate = this.values.startDate || undefined;
				this.existing.deadline = this.values.deadline;
				this.existing.status = this.values.status;
				this.existing.successMetric = this.values.successMetric;
				this.existing.why = this.values.why;
				this.existing.baseline = this.values.baseline || undefined;
				this.existing.obstacles = this.values.obstacles || undefined;
				this.existing.progress = this.values.progress;
				this.existing.linkedHabitIds = this.linkedHabitIdsDraft;
				this.existing.updatedAt = now;
				recordProgressHistory(this.plugin.data, this.existing.id, this.existing.progress);
			} else {
				const id = uid(slugify(this.values.name));
				this.plugin.data.outcomes.push({
					id,
					name: this.values.name.trim(),
					visionCategory: this.values.visionCategory,
					startDate: this.values.startDate || undefined,
					deadline: this.values.deadline,
					status: this.values.status,
					successMetric: this.values.successMetric,
					why: this.values.why,
					baseline: this.values.baseline || undefined,
					obstacles: this.values.obstacles || undefined,
					progress: this.values.progress,
					linkedHabitIds: this.linkedHabitIdsDraft,
					createdAt: now,
					updatedAt: now,
				});
				recordProgressHistory(this.plugin.data, id, this.values.progress);
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
		outcomeId: string;
		startDate: string;
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
					outcomeId: existing.outcomeId,
					startDate: existing.startDate ?? "",
					deadline: existing.deadline,
					status: existing.status,
					successMetric: existing.successMetric,
					priority: existing.priority,
					why: existing.why,
			  }
			: {
					outcomeId: plugin.data.outcomes[0]?.id ?? "",
					startDate: "",
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

		// A brand-new custom quarter needs a Goal to ladder up to, but an
		// already-existing (e.g. auto-generated) quarter should stay
		// editable — Priority/Why/dates — even before any Goal exists.
		if (!this.existing && this.plugin.data.outcomes.length === 0) {
			contentEl.createEl("p", { text: "Add a Goal first — a Quarter needs something to ladder up to." });
			return;
		}

		if (this.plugin.data.outcomes.length === 0) {
			contentEl.createEl("p", {
				text: "No Goals yet — add one to link this quarter to what it's actually laddering up to.",
				cls: "setting-item-description",
			});
		} else {
			new Setting(contentEl).setName("Goal").addDropdown((dd) => {
				this.plugin.data.outcomes.forEach((o) => dd.addOption(o.id, o.name));
				dd.setValue(this.values.outcomeId).onChange((v) => (this.values.outcomeId = v));
			});
		}
		new Setting(contentEl).setName("Start date").addText((t) => {
			t.inputEl.type = "date";
			t.setValue(this.values.startDate).onChange((v) => (this.values.startDate = v));
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
			if (this.checkinFieldsDraft.some((f) => !f.label.trim())) {
				new Notice("Give every check-in field a name, or remove the blank one(s).");
				return;
			}
			const checkinFields: CheckinField[] = this.checkinFieldsDraft.map((f) => ({ key: f.key, label: f.label.trim(), type: f.type }));
			const now = todayStr();

			// Quarter ids always follow the calendar (YYYY-Qn), derived from the
			// chosen start date (or today if left blank) — never hand-typed, so
			// two objects can never end up covering the same period again.
			const id = this.existing ? this.existing.id : quarterIdForDate(this.values.startDate ? new Date(this.values.startDate) : new Date());
			const target = this.existing ?? this.plugin.data.quarters.find((q) => q.id === id) ?? null;

			if (target) {
				target.outcomeId = this.values.outcomeId;
				target.startDate = this.values.startDate || target.startDate;
				target.deadline = this.values.deadline || target.deadline;
				target.status = this.values.status;
				target.successMetric = this.values.successMetric;
				target.priority = this.values.priority;
				target.why = this.values.why;
				target.checkinFields = checkinFields;
				target.updatedAt = now;
			} else {
				this.plugin.data.quarters.push({
					id,
					outcomeId: this.values.outcomeId,
					startDate: this.values.startDate || undefined,
					deadline: this.values.deadline,
					status: this.values.status,
					successMetric: this.values.successMetric,
					priority: this.values.priority,
					why: this.values.why,
					milestones: [],
					weeklyCommitments: [],
					dailyActionsPrompt: [],
					obstacles: "",
					checkinFields,
					checkins: {},
					createdAt: now,
					updatedAt: now,
				});
			}
			if (!this.existing) this.plugin.data.currentQuarterId = id;
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

		const activeOutcomes = this.plugin.data.outcomes.filter((o) => !o.archived && o.status === "active");
		const habits = getHabitTrackerHabits(this.plugin.app);
		if (habits && activeOutcomes.length) {
			const streakSection = el.createDiv({ cls: "lc-daily-streaks" });
			for (const outcome of activeOutcomes) {
				const linked = habits.filter((h) => (outcome.linkedHabitIds ?? []).includes(h.id));
				if (!linked.length) continue;
				const row = streakSection.createDiv({ cls: "lc-daily-streak-row" });
				row.createSpan({ text: outcome.name, cls: "lc-daily-streak-outcome" });
				for (const h of linked) {
					row.createSpan({ text: `${h.name} 🔥${getHabitStreak(this.plugin.app, h.id)}`, cls: "lc-daily-streak-chip" });
				}
			}
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

	const categoriesByKey = new Map<string, WheelCategory>();
	for (const c of remote.categories ?? []) categoriesByKey.set(c.key, c);
	for (const c of local.categories ?? []) categoriesByKey.set(c.key, c);
	const categories = categoriesByKey.size ? Array.from(categoriesByKey.values()) : [...DEFAULT_WHEEL_CATEGORIES];

	const outcomesById = new Map<string, Outcome>();
	for (const o of remote.outcomes ?? []) outcomesById.set(o.id, o);
	for (const o of local.outcomes ?? []) outcomesById.set(o.id, o);

	const quartersById = new Map<string, Quarter>();
	for (const q of remote.quarters ?? []) quartersById.set(q.id, q);
	for (const q of local.quarters ?? []) {
		const existing = quartersById.get(q.id);
		quartersById.set(q.id, existing ? { ...existing, ...q, checkins: { ...existing.checkins, ...q.checkins } } : q);
	}

	const ratingHistoryByKey = new Map<string, RatingHistoryEntry>();
	for (const e of remote.ratingHistory ?? []) ratingHistoryByKey.set(`${e.date}|${e.categoryKey}`, e);
	for (const e of local.ratingHistory ?? []) ratingHistoryByKey.set(`${e.date}|${e.categoryKey}`, e);

	const progressHistoryByKey = new Map<string, ProgressHistoryEntry>();
	for (const e of remote.progressHistory ?? []) progressHistoryByKey.set(`${e.date}|${e.outcomeId}`, e);
	for (const e of local.progressHistory ?? []) progressHistoryByKey.set(`${e.date}|${e.outcomeId}`, e);

	return {
		vision,
		categories,
		outcomes: Array.from(outcomesById.values()),
		quarters: Array.from(quartersById.values()),
		currentQuarterId: local.currentQuarterId ?? remote.currentQuarterId ?? null,
		ratingHistory: Array.from(ratingHistoryByKey.values()),
		progressHistory: Array.from(progressHistoryByKey.values()),
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
			categories: saved?.categories?.length ? saved.categories : [...DEFAULT_WHEEL_CATEGORIES],
			outcomes: saved?.outcomes ?? DEFAULT_DATA.outcomes,
			quarters: saved?.quarters ?? DEFAULT_DATA.quarters,
			currentQuarterId: saved?.currentQuarterId ?? DEFAULT_DATA.currentQuarterId,
			ratingHistory: saved?.ratingHistory ?? [],
			progressHistory: saved?.progressHistory ?? [],
		};
		this.ensureVisionDefaults();
		if (migrateLegacyQuarterIds(this.data)) await this.persist();
		await this.ensureCurrentYearQuarters();

		this.addSettingTab(new LifeCompassSettingTab(this.app, this));
		this.registerView(VIEW_TYPE, (leaf) => new LifeCompassView(leaf, this));
		this.addRibbonIcon("compass", "Open Life Compass", () => this.activateView());
		this.addCommand({ id: "open-life-compass", name: "Open Life Compass", callback: () => this.activateView() });
		this.addCommand({
			id: "import-goals-notes",
			name: "Import from Goals/ notes and clean up",
			callback: () => this.runMigration(),
		});
		this.addCommand({
			id: "design-tweaks",
			name: "Design Tweaks (live theme editor)",
			callback: () => LcTweakPanel.toggle(this),
		});
		this.registerMarkdownCodeBlockProcessor("life-compass-daily", (_source, el, ctx) => {
			const block = new DailyQuarterBlock(el, this);
			ctx.addChild(block);
		});

		if (this.settings.supabaseUrl && this.settings.supabaseAnonKey) {
			await this.initSupabase();
		}

		this.app.workspace.onLayoutReady(() => this.maybeShowWeeklyDigest());
	}

	// Sunday evening (local time, hour >= 18), at most once per calendar day
	// — guarded by settings.lastDigestShownDate so re-opening/reloading the
	// vault later the same Sunday evening doesn't pop it again.
	async maybeShowWeeklyDigest() {
		const now = new Date();
		if (now.getDay() !== 0 || now.getHours() < 18) return;
		const today = todayStr();
		if (this.settings.lastDigestShownDate === today) return;
		this.settings.lastDigestShownDate = today;
		await this.saveSettings();
		new WeeklyDigestModal(this).open();
	}

	onunload() {
		if (this.realtimeChannel) this.supabase?.removeChannel(this.realtimeChannel);
	}

	ensureVisionDefaults() {
		for (const cat of this.data.categories) {
			if (!this.data.vision[cat.key]) this.data.vision[cat.key] = { rating: 0, prose: "" };
		}
	}

	// Auto-generates this calendar year's Q1-Q4 (dates already filled in)
	// if they don't exist yet — runs on every load, so a new year's
	// quarters appear the first time the vault is opened after rollover.
	// If there's no current quarter pointed at yet, defaults it to
	// whichever quarter contains today.
	async ensureCurrentYearQuarters() {
		const added = ensureQuartersForYear(this.data, new Date().getFullYear());
		let currentChanged = false;
		if (!this.data.currentQuarterId || !this.data.quarters.some((q) => q.id === this.data.currentQuarterId)) {
			const todayId = quarterIdForDate(new Date());
			if (this.data.quarters.some((q) => q.id === todayId) && this.data.currentQuarterId !== todayId) {
				this.data.currentQuarterId = todayId;
				currentChanged = true;
			}
		}
		if (added.length || currentChanged) await this.persist();
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
			categories: this.data.categories,
			outcomes: imported.outcomes,
			quarters: imported.quarters,
			currentQuarterId: imported.currentQuarterId,
			ratingHistory: this.data.ratingHistory,
			progressHistory: this.data.progressHistory,
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
			// mergeData unions quarters by id (remote ∪ local) rather than
			// letting local deletions win, so a legacy non-calendar quarter id
			// already cleaned up locally can come back from an older remote
			// copy — re-run the migration so the fix actually sticks once this
			// gets persisted back up.
			migrateLegacyQuarterIds(this.data);
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
						categories: incoming.categories?.length ? incoming.categories : [...DEFAULT_WHEEL_CATEGORIES],
						outcomes: incoming.outcomes ?? [],
						quarters: incoming.quarters ?? [],
						currentQuarterId: incoming.currentQuarterId ?? null,
						ratingHistory: incoming.ratingHistory ?? [],
						progressHistory: incoming.progressHistory ?? [],
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
			categories: this.data.categories,
			outcomes: this.data.outcomes,
			quarters: this.data.quarters,
			currentQuarterId: this.data.currentQuarterId,
			ratingHistory: this.data.ratingHistory,
			progressHistory: this.data.progressHistory,
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
