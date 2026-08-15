/**
 * Movie Maker script parsing helpers.
 *
 * The Movie Maker script is a plain-text blob of tagged lines, e.g.:
 *   # [00:00.00 - 00:24.00][DIR] A dimly lit lounge...
 *   # [00:00.50 - 00:03.20][1]: Hello there.
 *     [2]: Hi.
 *   # [SFX] Door creaks
 *
 * Scenes are delimited by [DIR] blocks: a scene = one [DIR] line plus the
 * dialogue/annotation lines that follow it until the next [DIR]. These helpers
 * give the Scene Panel a stable per-scene view and let us splice a re-written
 * [DIR] back into the exact source line without disturbing timestamps.
 */

const TS = String.raw`\d{2}:\d{2}\.\d{2}\s*-\s*\d{2}:\d{2}\.\d{2}`;

const LINE_PREFIX_RE = new RegExp(String.raw`^#\s*`);
const TS_PREFIX_RE = new RegExp(String.raw`^\[${TS}\]\s*`);

/**
 * Strip an optional leading "# " and an optional [MM:SS.ss - MM:SS.ss] timestamp
 * prefix from a script line, returning the bare tagged content (e.g. "[1]: hi",
 * "[SFX] door creaks"). Any consumer that classifies a line purely by its tag,
 * dialogue vs SFX/MUS/DIR/NAR: should normalise with this first, so timestamped
 * LLM output and hand-typed lines are treated identically.
 */
export function stripLinePrefix(line: string): string {
  return line.trim().replace(LINE_PREFIX_RE, "").replace(TS_PREFIX_RE, "");
}

export interface SceneBlock {
  index: number;        // 1-based scene number (matches [DIR] order)
  timestamp: string;    // "00:00.00 - 00:24.00" or ""
  direction: string;    // [DIR] text (empty for a leading directionless scene)
  dirLineNo: number;    // index into script.split("\n") of the [DIR] line (-1 if none)
  dialogue: string;     // joined dialogue text for the scene
  speakerNums: number[];// distinct 1-based speaker numbers appearing in the scene
}

/**
 * Parse a Movie Maker script into scene blocks delimited by [DIR] lines.
 */
export function parseScenes(script: string): SceneBlock[] {
  const rawLines = script.split("\n");
  const scenes: SceneBlock[] = [];
  let current: SceneBlock | null = null;

  const dirTsRe = new RegExp(`^\\[(${TS})\\]\\[DIR\\]\\s*(.+)$`, "i");
  const dirPlainRe = /^\[DIR\]\s*(.+)$/i;
  const dlgTsRe = new RegExp(`^\\[(?:${TS})\\]\\[(\\d+)\\]:\\s*(.+)$`);
  const dlgPlainRe = /^\[(\d+)\]:\s*(.+)$/;

  const push = () => { if (current) scenes.push(current); };

  rawLines.forEach((line, i) => {
    const stripped = line.replace(/^#\s*/, "").trim();
    if (!stripped) return;

    // [DIR]: starts a new scene
    const dirTs = stripped.match(dirTsRe);
    const dirPlain = !dirTs ? stripped.match(dirPlainRe) : null;
    if (dirTs || dirPlain) {
      push();
      current = {
        index: scenes.length + 1,
        timestamp: dirTs ? dirTs[1].replace(/\s+/g, " ") : "",
        direction: (dirTs ? dirTs[2] : dirPlain![1]).trim(),
        dirLineNo: i,
        dialogue: "",
        speakerNums: [],
      };
      return;
    }

    // Dialogue line ([N]: text, optionally timestamped)
    const dlg = stripped.match(dlgTsRe) || stripped.match(dlgPlainRe);
    if (dlg) {
      const speaker = parseInt(dlg[1], 10);
      const text = dlg[2].trim();
      if (!current) {
        current = {
          index: scenes.length + 1,
          timestamp: "",
          direction: "",
          dirLineNo: -1,
          dialogue: "",
          speakerNums: [],
        };
      }
      current.dialogue += (current.dialogue ? " " : "") + text;
      if (Number.isFinite(speaker) && !current.speakerNums.includes(speaker)) {
        current.speakerNums.push(speaker);
      }
      return;
    }
    // [SFX]/[MUS]/[NAR] and other annotations are ignored for the scene view.
  });

  push();
  return scenes;
}

/**
 * Replace just the text of a [DIR] line, preserving its "# [timestamp][DIR] "
 * prefix exactly. Returns the updated full script.
 */
export function replaceSceneDirection(script: string, dirLineNo: number, newText: string): string {
  if (dirLineNo < 0) return script;
  const lines = script.split("\n");
  if (dirLineNo >= lines.length) return script;
  lines[dirLineNo] = lines[dirLineNo].replace(/(\[DIR\]\s*).*/i, `$1${newText.trim()}`);
  return lines.join("\n");
}
