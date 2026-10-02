/**
 * Direct-mode coding prompt lines that restate tool descriptions. Programmatic
 * cells drop them: the code tool's declarations already carry the same text.
 */
export const FULL_TOOL_INSTRUCTIONS = [
  "- read_file prefixes each line with its number and tab. Strip prefixes before copying; preserve newlines.",
  "- grep searches the workspace with ripgrep, falling back to grep.",
  "- bash runs one shell command in the workspace and returns its combined output.",
  "- write_file creates a file, or overwrites one only when overwrite is true.",
  "- edit_file replaces an exact string in a file. Match enough surrounding text",
  "  to make the target unique, or pass replace_all.",
  "- read_tool_output pages or literal-searches captured output by opaque handle.",
].join("\n");

export const PEBBLE_V1_TOOL_INSTRUCTIONS = [
  "- read_file prefixes each line with its number and tab. Strip prefixes before copying; preserve newlines.",
  "- bash runs one shell command in the workspace and returns its combined output.",
  "- write_file creates a file, or overwrites one only when overwrite is true.",
  "- edit_file replaces an exact string in a file. Match enough surrounding text",
  "  to make the target unique, or pass replace_all.",
].join("\n");

/** Remove the one SDK-rendered `Tools:` block; any other text is left byte-for-byte. */
export function withoutCodingToolGuidance(instructions: string): string {
  const block = [PEBBLE_V1_TOOL_INSTRUCTIONS, FULL_TOOL_INSTRUCTIONS]
    .map((lines) => `Tools:\n${lines}\n\n`)
    .find((candidate) => instructions.includes(candidate));
  return block === undefined ? instructions : instructions.replace(block, () => "");
}
