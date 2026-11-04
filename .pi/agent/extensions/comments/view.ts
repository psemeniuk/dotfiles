import { Editor, Markdown, sliceByColumn, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { diffChars } from "diff";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { Comment, SourceMessage } from "./model.ts";

export interface Cell { text: string; start: number; end: number; x: number; width: number }
export interface Row { cells: Cell[]; start: number; end: number }
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Source offsets remain UTF-16 offsets; terminal positions use grapheme display widths. */
export function layout(text: string, width: number): Row[] {
  width = Math.max(1, width);
  const rows: Row[] = [];
  let row: Row = { cells: [], start: 0, end: 0 };
  let x = 0;
  for (const part of segmenter.segment(text)) {
    const start = part.index, end = start + part.segment.length;
    if (/^[\r\n]+$/.test(part.segment)) {
      row.end = start; rows.push(row); row = { cells: [], start: end, end }; x = 0; continue;
    }
    // Never let message-supplied terminal control sequences execute in our raw view.
    let value = part.segment === "\t" ? "    " : part.segment.replace(/[\x00-\x1f\x7f-\x9f]/g, "�");
    let size = visibleWidth(value);
    if (size > width) { value = "�"; size = 1; }
    if (x + size > width && row.cells.length) {
      rows.push(row); row = { cells: [], start, end: start }; x = 0;
    }
    row.cells.push({ text: value, start, end, x, width: size });
    x += size; row.end = end;
  }
  rows.push(row);
  return rows;
}
/** Render with Pi's own Markdown component, then align visible text to source offsets.
 * Inserted decorations are displayed but never become selectable source text. */
export function markdownLayout(text: string, width: number): Row[] {
  const lines = new Markdown(text.trim(), 0, 0, getMarkdownTheme()).render(Math.max(1, width));
  const plain = lines.map(stripAnsi).join("\n");
  const offsets = new Int32Array(plain.length).fill(-1);
  let source = 0, rendered = 0;
  for (const part of diffChars(text, plain, { timeout: 1000 }) ?? []) {
    if (part.removed) source += part.value.length;
    else if (part.added) rendered += part.value.length;
    else for (let i = 0; i < part.value.length; i++) offsets[rendered++] = source++;
  }
  let offset = 0;
  return lines.map(line => {
    const cells: Cell[] = [];
    let x = 0;
    for (const part of segmenter.segment(stripAnsi(line))) {
      const size = visibleWidth(part.segment);
      const start = offsets[offset + part.index];
      const last = offsets[offset + part.index + part.segment.length - 1];
      const matched = start >= 0 && text.slice(start, last + 1) === part.segment;
      cells.push({ text: sliceByColumn(line, x, size, true), x, width: size,
        start: matched ? start : -1, end: matched ? last + 1 : -1 });
      x += size;
    }
    offset += stripAnsi(line).length + 1;
    const mapped = cells.filter(c => c.start >= 0);
    return { cells, start: mapped[0]?.start ?? -1, end: mapped.at(-1)?.end ?? -1 };
  });
}

function frame(lines: string[], width: number, theme: Theme): string[] {
  if (width < 2) return lines.map(line => truncateToWidth(line, width));
  const inner = width - 2;
  const border = (s: string) => theme.fg("borderMuted", s);
  return [border("╭" + "─".repeat(inner) + "╮"),
    ...lines.map(line => border("│") + truncateToWidth(line, inner, "", true) + "\x1b[0m\x1b]8;;\x1b\\" + border("│")),
    border("╰" + "─".repeat(inner) + "╯")];
}

const safe = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export class CommentsView implements Component {
  index: number;
  top = 0;
  rows: Row[] = [];
  bodyHeight = 10;
  cursor = 0;
  anchor?: number;
  selected?: { start: number; end: number };
  activeId?: string;
  private press?: { cell: Cell; x: number; y: number };
  private busy = false;
  private cachedText?: string;
  private cachedWidth = 0;
  readonly gutter = 9;
  constructor(
    readonly tui: TUI,
    readonly theme: Theme,
    readonly messages: SourceMessage[],
    readonly comments: () => Comment[],
    readonly open: (source: SourceMessage, start: number, end: number, existing?: Comment) => Promise<void>,
    readonly done: () => void,
    readonly onError: (error: unknown) => void,
  ) { this.index = messages.length - 1; }
  get source() { return this.messages[this.index]; }
  get localComments() { return this.comments().filter(c => c.messageId === this.source.id); }
  invalidate() { this.cachedText = undefined; }
  private request() { this.tui.requestRender(); }
  private cellAt(x: number, y: number): Cell | undefined {
    const row = this.rows[Math.max(0, Math.min(this.rows.length - 1, this.top + y - 3))];
    if (!row?.cells.length) return undefined;
    const col = x - this.gutter - 1;
    const cells = row.cells.filter(c => c.start >= 0);
    return cells.find(c => col < c.x + c.width) ?? cells.at(-1);
  }
  private scroll(delta: number) { this.top = Math.max(0, Math.min(Math.max(0, this.rows.length - this.bodyHeight), this.top + delta)); }
  private reveal(offset: number) {
    const row = this.rows.findIndex(r => r.start <= offset && offset <= r.end);
    if (row < this.top) this.top = Math.max(0, row);
    else if (row >= this.top + this.bodyHeight) this.top = row - this.bodyHeight + 1;
  }
  private async edit(start: number, end: number, existing?: Comment) {
    if (this.busy) return;
    this.busy = true;
    try { await this.open(this.source, start, end, existing); }
    catch (error) { this.onError(error); }
    finally { this.busy = false; this.selected = undefined; this.anchor = undefined; this.request(); }
  }
  private at(offset: number) { return this.localComments.find(c => c.start <= offset && offset < c.end); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (this.busy) return { handled: true };
    if (event.type === "wheel") { this.scroll(event.wheelDelta ?? 0); return { handled: true, render: true }; }
    if (event.type === "press" && event.button === "left" && event.y >= 3 && event.y < 3 + this.bodyHeight) {
      const cell = this.cellAt(event.x, event.y);
      if (cell) { this.press = { cell, x: event.x, y: event.y }; this.cursor = cell.start; this.selected = undefined; this.activeId = undefined; }
      return { handled: true, capture: true };
    }
    if ((event.type === "drag" || event.type === "release") && this.press) {
      if (event.y < 3) this.scroll(-1);
      if (event.y >= 3 + this.bodyHeight) this.scroll(1);
      const cell = this.cellAt(event.x, event.y) ?? this.press.cell;
      const moved = event.x !== this.press.x || event.y !== this.press.y;
      if (moved || this.selected) this.selected = { start: Math.min(this.press.cell.start, cell.start), end: Math.max(this.press.cell.end, cell.end) };
      if (event.type === "release") {
        const existing = !this.selected ? this.at(cell.start) : undefined;
        this.press = undefined;
        if (existing) void this.edit(existing.start, existing.end, existing);
        else if (this.selected) void this.edit(this.selected.start, this.selected.end);
      }
      return { handled: true, render: true };
    }
    return { handled: true };
  }
  handleInput(data: string) {
    if (this.busy) return;
    if (matchesKey(data, "escape")) { this.done(); return; }
    if (data === "[" || data === "]") {
      this.index = (this.index + (data === "[" ? -1 : 1) + this.messages.length) % this.messages.length;
      this.top = 0; this.cursor = 0; this.anchor = undefined; this.selected = undefined; this.activeId = undefined;
    } else if (matchesKey(data, "tab")) {
      const list = this.localComments;
      const c = list[(list.findIndex(c => c.id === this.activeId) + 1) % list.length];
      if (c) { this.activeId = c.id; this.cursor = c.start; this.selected = undefined; this.anchor = undefined; this.reveal(c.start); }
    } else if (matchesKey(data, "enter")) {
      const existing = this.localComments.find(c => c.id === this.activeId) ?? (!this.selected ? this.at(this.cursor) : undefined);
      if (existing) void this.edit(existing.start, existing.end, existing);
      else if (this.selected) void this.edit(this.selected.start, this.selected.end);
    } else if (data === " ") {
      this.anchor = this.anchor === undefined ? this.cursor : undefined;
      this.selected = undefined; this.activeId = undefined;
    } else if (matchesKey(data, "pageUp")) this.scroll(-this.bodyHeight);
    else if (matchesKey(data, "pageDown")) this.scroll(this.bodyHeight);
    else {
      const cells = this.rows.flatMap(r => r.cells).filter(c => c.start >= 0);
      let i = cells.findIndex(c => c.start === this.cursor);
      if (i < 0) i = 0;
      const old = cells[i];
      const rowIndex = this.rows.findIndex(r => r.cells.includes(old));
      const direction = ["left", "right", "up", "down"].find(k => matchesKey(data, k as any) || matchesKey(data, `shift+${k}` as any));
      if (!direction) return;
      if (matchesKey(data, `shift+${direction}` as any) && this.anchor === undefined) this.anchor = this.cursor;
      if (direction === "left") i--;
      if (direction === "right") i++;
      let target = cells[Math.max(0, Math.min(cells.length - 1, i))];
      if (direction === "up" || direction === "down") {
        const step = direction === "up" ? -1 : 1;
        target = old;
        for (let r = rowIndex + step; r >= 0 && r < this.rows.length; r += step) {
          const mapped = this.rows[r].cells.filter(c => c.start >= 0);
          if (!mapped.length) continue;
          target = mapped.find(c => c.x >= (old?.x ?? 0)) ?? mapped.at(-1)!;
          break;
        }
      }
      if (target) {
        this.cursor = target.start; this.activeId = undefined;
        if (this.anchor !== undefined) {
          const anchorCell = cells.find(c => c.start === this.anchor)!;
          this.selected = { start: Math.min(this.anchor, target.start), end: Math.max(anchorCell?.end ?? this.anchor, target.end) };
        }
        this.reveal(this.cursor);
      }
    }
    this.request();
  }
  render(width: number): string[] {
    this.bodyHeight = Math.max(1, Math.min(32, this.tui.terminal.rows - 8));
    const contentWidth = Math.max(1, width - this.gutter - 3);
    if (this.cachedText !== this.source.text || this.cachedWidth !== contentWidth) {
      this.rows = markdownLayout(this.source.text, contentWidth); this.cachedText = this.source.text; this.cachedWidth = contentWidth;
      if (!this.rows.some(r => r.cells.some(c => c.start === this.cursor))) {
        this.cursor = this.rows.flatMap(r => r.cells).find(c => c.start >= 0)?.start ?? 0;
      }
    }
    this.scroll(0);
    const th = this.theme;
    const local = this.localComments;
    const lines = [th.fg("accent", ` Comments · response ${this.index + 1}/${this.messages.length}`),
      th.fg("muted", " [ / ] response · drag to comment · Tab comments · Enter open · Esc close")];
    for (let n = 0; n < this.bodyHeight; n++) {
      const row = this.rows[this.top + n];
      if (!row) { lines.push(""); continue; }
      const tags = local.filter(c => c.start < row.end && c.end > row.start);
      const label = tags.length ? tags[0].id + (tags.length > 1 ? "+" : "") : "";
      let line = th.fg("accent", label.padStart(this.gutter - 2) + "  ");
      for (const cell of row.cells) {
        const comment = local.find(c => c.start < cell.end && c.end > cell.start);
        const selected = this.selected && this.selected.start < cell.end && this.selected.end > cell.start;
        let value = cell.text;
        if (selected || cell.start === this.cursor) value = th.bg("selectedBg", value);
        else if (comment) value = th.bg(comment.batchId ? "toolSuccessBg" : "toolPendingBg", value);
        line += value;
      }
      lines.push(line);
    }
    const active = local.find(c => c.id === this.activeId) ?? this.at(this.cursor);
    lines.push(th.fg("muted", active ? ` ${active.id} · ${active.batchId ? active.answer ? "answered" : "submitted" : "draft"} · ${safe(active.text)}` : " Arrows move · Space/Shift+arrows select · Enter comment · PgUp/PgDn scroll"));
    const drafts = this.comments().filter(c => !c.batchId).length;
    const actions = drafts ? " · close then /submit-comments or /cancel-comments" : this.comments().length ? " · close then /cancel-comments" : "";
    lines.push(th.fg("dim", ` ${drafts} drafts${actions} · ${this.top + 1}/${this.rows.length}`));
    return frame(lines, width, th);
  }
}

/** Small editor overlay; a separate instance is created for each interaction. */
export class CommentEditor implements Component {
  readonly editor: Editor;
  constructor(readonly tui: TUI, readonly theme: Theme, readonly title: string, text: string,
    readonly done: (value: { text: string } | { delete: true } | undefined) => void, readonly deletable: boolean) {
    this.editor = new Editor(tui, {
      borderColor: s => theme.fg("border", s),
      selectList: { selectedPrefix: s => theme.fg("accent", s), selectedText: s => theme.fg("accent", s), description: s => theme.fg("muted", s), scrollInfo: s => theme.fg("dim", s), noMatch: s => theme.fg("warning", s) },
    });
    this.editor.setText(text);
    this.editor.onSubmit = value => { if (value.trim()) done({ text: value }); };
  }
  get focused() { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  invalidate() { this.editor.invalidate(); }
  handleInput(data: string) {
    if (matchesKey(data, "escape")) this.done(undefined);
    else if (matchesKey(data, "ctrl+d") && this.deletable) this.done({ delete: true });
    else this.editor.handleInput(data);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (event.y < 1) return { handled: true };
    return this.editor.handleMouse({ ...event, y: event.y - 1, height: Math.max(1, event.height - 2) }) ?? { handled: true };
  }
  render(width: number) {
    return [truncateToWidth(this.theme.fg("accent", ` ${this.title}`), width), ...this.editor.render(width),
      truncateToWidth(" Enter save · Shift+Enter newline · Esc cancel" + (this.deletable ? " · Ctrl+D delete" : ""), width)];
  }
}

export class AnswerView implements Component {
  top = 0;
  private rows: string[] = [];
  private height = 10;
  constructor(readonly tui: TUI, readonly theme: Theme, readonly title: string, readonly text: string, readonly done: () => void) {}
  invalidate() {}
  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) this.done();
    else if (matchesKey(data, "up")) this.top--;
    else if (matchesKey(data, "down")) this.top++;
    else if (matchesKey(data, "pageUp")) this.top -= this.height;
    else if (matchesKey(data, "pageDown")) this.top += this.height;
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent) { if (event.type === "wheel") this.top += event.wheelDelta ?? 0; return { handled: true, render: true }; }
  render(width: number) {
    this.height = Math.max(1, Math.min(25, this.tui.terminal.rows - 8));
    this.rows = new Markdown(this.text.trim(), 0, 0, getMarkdownTheme()).render(Math.max(1, width - 4));
    this.top = Math.max(0, Math.min(Math.max(0, this.rows.length - this.height), this.top));
    return frame([this.theme.fg("accent", ` ${this.title}`), ...Array.from({ length: this.height }, (_, i) => " " + (this.rows[this.top + i] ?? "")),
      this.theme.fg("dim", " ↑/↓ · PgUp/PgDn · wheel · Esc close")], width, this.theme);
  }
}
