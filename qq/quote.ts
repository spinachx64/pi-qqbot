/** QQ pushes do not always include the referenced message's text or author. */
export interface ParsedQuote {
  msgIdx?: string;
  refMsgIdx?: string;
  quoteStatus?: "resolved" | "missing";
  quotedText?: string;
  quotedSenderName?: string;
  quotedSenderOpenid?: string;
}

export const MAX_QUOTED_TEXT_CHARS = 4000;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const nonempty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

function extValues(ext: unknown, name: string): Set<string> {
  const values = new Set<string>();
  if (!Array.isArray(ext)) return values;
  for (const entry of ext) {
    if (typeof entry !== "string") continue;
    const equal = entry.indexOf("=");
    // An index can contain +, / and any number of = characters. Do not split it.
    if (equal < 0 || entry.slice(0, equal).trim() !== name) continue;
    const value = nonempty(entry.slice(equal + 1));
    if (value) values.add(value);
  }
  return values;
}

/** Bound UTF-16 length without leaving a dangling high surrogate. */
function boundedText(text: string): string {
  const value = text.slice(0, MAX_QUOTED_TEXT_CHARS);
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
}

function resolved(result: ParsedQuote, candidates: ObjectValue[]): ParsedQuote {
  if (!candidates.length) return { ...result, quoteStatus: "missing" };
  const first = candidates[0];
  const content = nonempty(first.content);
  // Conflicting candidates or absent text must not be replaced with a guess.
  if (!content || candidates.some(candidate => candidate.content !== content)) {
    return { ...result, quoteStatus: "missing" };
  }
  const authors = candidates.map(candidate => object(candidate.author));
  const author = authors[0];
  const sameAuthor = authors.every(other =>
    other.member_openid === author.member_openid && other.username === author.username);
  return {
    ...result,
    quoteStatus: "resolved",
    quotedText: boundedText(content),
    // Never substitute the current message's author for the quoted author.
    quotedSenderOpenid: sameAuthor ? nonempty(author.member_openid) : undefined,
    quotedSenderName: sameAuthor ? nonempty(author.username) : undefined,
  };
}

/** Stateless, event-local parsing: no history/cache lookup and no recursive quotes. */
export function parseQuote(raw: unknown): ParsedQuote {
  const message = object(raw);
  const ext = object(message.message_scene).ext;
  const indices = extValues(ext, "msg_idx");
  const refs = extValues(ext, "ref_msg_idx");
  const msgIdx = indices.size === 1 ? [...indices][0] : undefined;
  const refMsgIdx = refs.size === 1 ? [...refs][0] : undefined;
  const result: ParsedQuote = { msgIdx, refMsgIdx };
  const reference = object(message.message_reference);
  const referenceId = nonempty(reference.message_id);
  const elements = Array.isArray(message.msg_elements) ? message.msg_elements.map(object) : [];

  if (refs.size > 1) return { ...result, quoteStatus: "missing" };
  if (refMsgIdx) {
    if (refMsgIdx === msgIdx) return { ...result, quoteStatus: "missing" };
    const exact = elements.filter(element => element.msg_idx === refMsgIdx);
    if (exact.length) return resolved(result, exact);
  }

  // Explicit message_reference relates message IDs, not ref-index strings.
  if (referenceId) {
    if (referenceId === message.id) return { ...result, quoteStatus: "missing" };
    const exact = elements.filter(element =>
      (element.message_id === referenceId || element.id === referenceId) &&
      (!refMsgIdx || !nonempty(element.msg_idx) || element.msg_idx === refMsgIdx));
    if (exact.length) return resolved(result, exact);
  }

  // Defensive compatibility for explicit quote elements. Numeric 103 is NOT a
  // quote marker: real pushes also use it for merged/multi-level messages.
  const marked = elements.filter(element =>
    element.type === "quote" || element.type === "reply" || element.is_quote === true);
  const compatible = marked.filter(element => {
    const index = nonempty(element.msg_idx);
    const id = nonempty(element.message_id) ?? nonempty(element.id);
    return (!refMsgIdx || !index || index === refMsgIdx) &&
      (!referenceId || !id || id === referenceId);
  });
  if (compatible.length) return resolved(result, compatible);
  if (refMsgIdx || referenceId || marked.length) return { ...result, quoteStatus: "missing" };
  return result;
}
