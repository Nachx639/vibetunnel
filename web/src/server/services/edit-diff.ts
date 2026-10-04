/**
 * What an Edit, MultiEdit or Write changed, as a short line diff for the phone chat. The tool
 * result alone says only "The file … has been updated successfully", so without this the
 * change could not be reviewed from the phone.
 */

/** Lines kept per change; the rest is only counted (`more`). */
const MAX_LINES = 40;
/** Characters kept per line, its sign included. */
const MAX_LINE_CHARS = 200;
/** Past this many changed lines per side, no line-by-line match (the cost is quadratic). */
const MAX_COMPARED_LINES = 300;
/** Unchanged lines kept around a change; a longer run between two changes becomes "…". */
const CONTEXT = 2;
/** Marks unchanged lines left out between two changes (or two edits of a MultiEdit). */
export const DIFF_GAP = '…';

export interface ChatDiff {
  /** Each line starts with '-' (removed), '+' (added) or ' ' (unchanged), or is DIFF_GAP. */
  lines: string[];
  /** Lines left out past the first MAX_LINES. */
  more: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Keeps CONTEXT unchanged lines next to each change. */
function trimContext(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i][0] !== ' ') {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j][0] === ' ') j++;
    const run = lines.slice(i, j);
    if (i === 0) out.push(...run.slice(-CONTEXT));
    else if (j === lines.length) out.push(...run.slice(0, CONTEXT));
    else if (run.length > 2 * CONTEXT + 1) {
      out.push(...run.slice(0, CONTEXT), DIFF_GAP, ...run.slice(-CONTEXT));
    } else out.push(...run);
    i = j;
  }
  return out;
}

/** Line diff of old → new; empty when nothing changed. */
function diffLines(oldLines: string[], newLines: string[]): string[] {
  // An edit usually changes a few lines in the middle: match the common ends first.
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const a = oldLines.slice(start, endOld);
  const b = newLines.slice(start, endNew);
  if (a.length === 0 && b.length === 0) return [];

  const middle: string[] = [];
  if (a.length > MAX_COMPARED_LINES || b.length > MAX_COMPARED_LINES) {
    for (const line of a) middle.push(`-${line}`);
    for (const line of b) middle.push(`+${line}`);
  } else {
    // Longest common subsequence, filled from the end so the walk below goes forward.
    const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push(` ${a[i++]}`);
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) middle.push(`-${a[i++]}`);
      else middle.push(`+${b[j++]}`);
    }
    while (i < a.length) middle.push(`-${a[i++]}`);
    while (j < b.length) middle.push(`+${b[j++]}`);
  }
  return trimContext([
    ...oldLines.slice(0, start).map((line) => ` ${line}`),
    ...middle,
    ...oldLines.slice(endOld).map((line) => ` ${line}`),
  ]);
}

function capped(lines: string[]): ChatDiff | undefined {
  if (lines.length === 0) return undefined;
  return {
    lines: lines
      .slice(0, MAX_LINES)
      .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line)),
    more: Math.max(0, lines.length - MAX_LINES),
  };
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The change a tool call makes, for the tools that edit files; undefined for the rest. */
export function diffForToolUse(
  name: string,
  input: Record<string, unknown> | undefined
): ChatDiff | undefined {
  switch (name) {
    case 'Edit': {
      const before = text(input?.old_string);
      const after = text(input?.new_string);
      if (before === undefined || after === undefined) return undefined;
      return capped(diffLines(splitLines(before), splitLines(after)));
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input?.edits)
        ? (input.edits as Array<Record<string, unknown>>)
        : [];
      const lines: string[] = [];
      for (const edit of edits) {
        const before = text(edit?.old_string);
        const after = text(edit?.new_string);
        if (before === undefined || after === undefined) continue;
        const part = diffLines(splitLines(before), splitLines(after));
        if (part.length === 0) continue;
        if (lines.length > 0) lines.push(DIFF_GAP);
        lines.push(...part);
      }
      return capped(lines);
    }
    case 'Write': {
      const content = text(input?.content);
      return content === undefined ? undefined : capped(splitLines(content).map((l) => `+${l}`));
    }
    default:
      return undefined;
  }
}
