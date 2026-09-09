/**
 * A minimal delimiter scanner for brace languages.
 *
 * It exists for one reason: this dropper appends its payload to the *end of an
 * existing line*, typically straight after the `};` that closes a config
 * object. Deleting that whole line takes the `};` with it and leaves a file
 * that no longer parses. To cut the payload off without breaking the file we
 * need to know where the legitimate code on that line ends.
 *
 * It is not a JavaScript parser and does not try to be. It tracks strings,
 * template literals and comments well enough not to be fooled by a brace
 * inside a string, and everything it produces is checked afterwards by
 * `isBalanced` — so a mis-read makes the cleanup refuse, never corrupt.
 */

export interface Balance {
  curly: number;
  paren: number;
  square: number;
}

export interface LineInfo {
  /** Delimiter depth at the first character of this line. */
  startBalance: Balance;
  /**
   * Line-relative end offsets at which the prefix is a complete, fully closed
   * run of code — every bracket balanced and the last character a `;` or `}`.
   * A payload appended after the config object starts right after one of these.
   */
  safeCuts: number[];
}

export interface SourceAnalysis {
  lines: LineInfo[];
  /** True when the whole text closes every delimiter it opens. */
  balanced: boolean;
}

type Mode = "code" | "line-comment" | "block-comment" | "single" | "double" | "template";

const BRACE_LANGUAGE = /\.(?:js|jsx|ts|tsx|mjs|cjs|json)$/i;

/** Whether an unbalanced result in this file type would actually break it. */
export function isBraceLanguage(path: string): boolean {
  return BRACE_LANGUAGE.test(path);
}

export function analyzeSource(text: string): SourceAnalysis {
  let curly = 0;
  let paren = 0;
  let square = 0;
  let mode: Mode = "code";

  const lines: LineInfo[] = [
    { startBalance: { curly: 0, paren: 0, square: 0 }, safeCuts: [] },
  ];
  let lineIdx = 0;
  let lineStart = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "\n") {
      if (mode === "line-comment") mode = "code";
      lineIdx++;
      lineStart = i + 1;
      lines.push({ startBalance: { curly, paren, square }, safeCuts: [] });
      continue;
    }

    if (mode === "line-comment") continue;

    if (mode === "block-comment") {
      if (ch === "*" && next === "/") {
        mode = "code";
        i++;
      }
      continue;
    }

    if (mode === "single" || mode === "double" || mode === "template") {
      if (ch === "\\") {
        i++; // escaped character — never closes the literal
        continue;
      }
      if (
        (mode === "single" && ch === "'") ||
        (mode === "double" && ch === '"') ||
        (mode === "template" && ch === "`")
      ) {
        mode = "code";
      }
      continue;
    }

    // mode === "code"
    if (ch === "/" && next === "/") {
      mode = "line-comment";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      mode = "block-comment";
      i++;
      continue;
    }
    if (ch === "'") {
      mode = "single";
      continue;
    }
    if (ch === '"') {
      mode = "double";
      continue;
    }
    if (ch === "`") {
      mode = "template";
      continue;
    }

    if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;

    if ((ch === ";" || ch === "}") && curly === 0 && paren === 0 && square === 0) {
      lines[lineIdx].safeCuts.push(i - lineStart + 1);
    }
  }

  return {
    lines,
    balanced: curly === 0 && paren === 0 && square === 0 && mode === "code",
  };
}

export function isBalanced(text: string): boolean {
  return analyzeSource(text).balanced;
}

/**
 * Given one line, the safe cut offsets on it, and the column of the earliest
 * rule match, return the legitimate prefix to keep — or null when there is no
 * safe split and the whole line has to go.
 */
export function splitAtPayload(
  line: string,
  safeCuts: number[],
  firstMatchColumn: number,
): string | null {
  // The earliest fully-closed point at or before the match is where the real
  // code ended and the appended payload began.
  const cut = safeCuts.find((c) => c <= firstMatchColumn);
  if (cut === undefined) return null;

  // Absorb trailing statement terminators so `}` becomes `};`.
  let end = cut;
  while (end < line.length && (line[end] === ";" || line[end] === " " || line[end] === "\t")) {
    end++;
  }

  const prefix = line.slice(0, end).replace(/[ \t]+$/, "");
  if (prefix.trim() === "") return null; // nothing worth keeping
  if (prefix.length >= line.replace(/[ \t\r]+$/, "").length) return null; // nothing removed
  return prefix;
}
