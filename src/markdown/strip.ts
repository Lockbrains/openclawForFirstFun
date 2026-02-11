/**
 * Strip markdown formatting from text, returning plain text.
 * Used for channels that don't support markdown (e.g. iMessage, BlueBubbles).
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Code blocks (preserve content)
  result = result.replace(/```[\s\S]*?```/g, (m) => {
    const content = m.slice(3, -3).trim();
    const firstLine = content.split("\n")[0];
    return firstLine?.startsWith(" ") ? content : (firstLine ?? content);
  });
  result = result.replace(/`[^`]+`/g, (m) => m.slice(1, -1));

  // Links: [text](url) or [text] -> text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  result = result.replace(/\[([^\]]+)\]/g, "$1");

  // Bold/italic: **text** __text__ *text* _text_ -> text
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/__([^_]+)__/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/_([^_]+)_/g, "$1");

  // Strikethrough: ~~text~~ -> text
  result = result.replace(/~~([^~]+)~~/g, "$1");

  // Headers: # text -> text
  result = result.replace(/^#{1,6}\s+/gm, "");

  // Blockquotes: > text -> text
  result = result.replace(/^>\s*/gm, "");

  return result.trim();
}
