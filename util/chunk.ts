/**
 * Markdown 文本切分器：QQ 单条消息有字节上限（默认 1900），需要按行切分，
 * 并保持 GFM 表格、代码块的完整性（长表格不拦腰截断，否则 md 渲染出破表）。
 */
const CODE_FENCE = /^```/;
const GFM_TABLE_LINE = /^\|.+\|$/;

export function splitText(text: string, maxBytes = 1900): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text ? [text] : [];
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  let inCodeBlock = false;
  let tableLines: string[] = [];

  const flushCurrent = () => {
    if (!current) return;
    parts.push(current);
    current = "";
    currentBytes = 0;
  };
  /** 单行超过上限：按字符硬切（罕见，保持旧行为兜底） */
  const pushCharSplit = (line: string) => {
    let buf = "";
    let bufBytes = 0;
    for (const ch of line) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (bufBytes + chBytes > maxBytes) {
        parts.push(buf);
        buf = ch;
        bufBytes = chBytes;
      } else {
        buf += ch;
        bufBytes += chBytes;
      }
    }
    if (buf) parts.push(buf);
  };
  const appendLine = (line: string) => {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (!current) {
      if (lineBytes > maxBytes) {
        pushCharSplit(line);
        return;
      }
      current = line;
      currentBytes = lineBytes;
      return;
    }
    const joinBytes = 1; // 拼接的换行符
    if (currentBytes + joinBytes + lineBytes > maxBytes) {
      flushCurrent();
      if (lineBytes > maxBytes) {
        pushCharSplit(line);
        return;
      }
      current = line;
      currentBytes = lineBytes;
    } else {
      current += "\n" + line;
      currentBytes += joinBytes + lineBytes;
    }
  };
  /** 表格整块提交：先尽力并入 current，放不下就整块另起一条消息 */
  const flushTable = () => {
    if (tableLines.length === 0) return;
    const block = tableLines.join("\n");
    tableLines = [];
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (!current) {
      current = block;
      currentBytes = blockBytes;
      return;
    }
    if (currentBytes + 1 + blockBytes > maxBytes) {
      flushCurrent();
      current = block;
      currentBytes = blockBytes;
    } else {
      current += "\n" + block;
      currentBytes += 1 + blockBytes;
    }
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (CODE_FENCE.test(line)) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      appendLine(line);
      continue;
    }
    if (inCodeBlock) {
      appendLine(line);
      continue;
    }
    if (GFM_TABLE_LINE.test(line)) {
      tableLines.push(line);
      continue;
    }
    flushTable();
    appendLine(line);
  }
  flushTable();
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [text];
}
