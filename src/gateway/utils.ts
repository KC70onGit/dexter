export function normalizeE164(number: string): string {
  const withoutPrefix = number.replace(/^whatsapp:/, '').trim();
  // Strip everything except digits; we deliberately ignore any number of leading '+'.
  const digitsOnly = withoutPrefix.replace(/[^\d]/g, '');
  if (!digitsOnly) {
    return '+';
  }
  return `+${digitsOnly}`;
}

export function isSelfChatMode(
  selfE164: string | null | undefined,
  allowFrom?: Array<string | number> | null,
): boolean {
  if (!selfE164) {
    return false;
  }
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
    return false;
  }
  const normalizedSelf = normalizeE164(selfE164);
  return allowFrom.some((value) => {
    if (value === '*') {
      return false;
    }
    try {
      return normalizeE164(String(value)) === normalizedSelf;
    } catch {
      return false;
    }
  });
}

/**
 * Convert a phone number or JID to a WhatsApp JID suitable for sending messages.
 * 
 * - Strips 'whatsapp:' prefix if present
 * - For JIDs with @s.whatsapp.net, strips device suffix (e.g., :0)
 * - For group JIDs (@g.us), returns as-is
 * - Otherwise, normalizes as E.164 and converts to @s.whatsapp.net format
 */
/**
 * Clean up markdown for WhatsApp compatibility.
 * - Converts `**text**` (markdown bold) to `*text*` (WhatsApp bold)
 * - Merges adjacent bold sections to prevent literal asterisks showing
 */
export function cleanMarkdownForWhatsApp(text: string): string {
  let result = text;
  // Convert markdown bold (**text**) to WhatsApp bold (*text*)
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  // Merge adjacent bold sections: `*foo* *bar*` -> `*foo bar*`
  result = result.replace(/\*([^*]+)\*\s+\*([^*]+)\*/g, '*$1 $2*');
  return result;
}

/**
 * Basic markdown to HTML for Telegram
 */
export function cleanMarkdownForTelegram(text: string): string {
  let result = text;
  // Escape raw HTML entities
  result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // Italic
  result = result.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  return result;
}

function parseTelegramTag(token: string): { name: string; closing: boolean; selfClosing: boolean } | null {
  const match = token.match(/^<\s*(\/)?\s*([a-zA-Z0-9]+)(?:\s+[^>]*)?(\/)?\s*>$/);
  if (!match) {
    return null;
  }
  return {
    closing: Boolean(match[1]),
    name: match[2].toLowerCase(),
    selfClosing: Boolean(match[3]),
  };
}

export function stripTelegramHtml(text: string): string {
  return text.replace(/<\/?[^>]+>/g, '');
}

export function chunkTelegramHtml(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const tokens = text.match(/<[^>]+>|[^<]+/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  let openTags: string[] = [];
  let lastBreakIndex = -1;
  let lastBreakStackDepth = 0;

  const closingTags = (stack: string[]): string => stack.slice().reverse().map((tag) => `</${tag}>`).join('');
  const openingTags = (stack: string[]): string => stack.map((tag) => `<${tag}>`).join('');
  const currentSuffixLen = (): number => closingTags(openTags).length;

  const markBreak = () => {
    lastBreakIndex = current.length;
    lastBreakStackDepth = openTags.length;
  };

  const pushChunk = (cutIndex?: number, cutStackDepth?: number) => {
    const effectiveCutIndex = cutIndex ?? current.length;
    const effectiveStackDepth = cutStackDepth ?? openTags.length;
    const activeStack = openTags.slice(0, effectiveStackDepth);
    const head = current.slice(0, effectiveCutIndex);
    if (head) {
      chunks.push(`${head}${closingTags(activeStack)}`);
    }
    const tail = current.slice(effectiveCutIndex);
    openTags = activeStack;
    current = `${openingTags(openTags)}${tail}`;
    lastBreakIndex = -1;
    lastBreakStackDepth = 0;
  };

  for (const token of tokens) {
    const tag = parseTelegramTag(token);
    if (tag) {
      if (current.length + token.length + currentSuffixLen() > maxLen && current.length > 0) {
        pushChunk(lastBreakIndex > 0 ? lastBreakIndex : undefined, lastBreakIndex > 0 ? lastBreakStackDepth : undefined);
      }
      current += token;
      if (!tag.selfClosing) {
        if (tag.closing) {
          const idx = openTags.lastIndexOf(tag.name);
          if (idx >= 0) {
            openTags = openTags.slice(0, idx);
          }
        } else {
          openTags.push(tag.name);
        }
      }
      continue;
    }

    for (const char of token) {
      if (current.length + char.length + currentSuffixLen() > maxLen && current.length > 0) {
        pushChunk(lastBreakIndex > 0 ? lastBreakIndex : undefined, lastBreakIndex > 0 ? lastBreakStackDepth : undefined);
      }
      current += char;
      if (/\s/.test(char)) {
        markBreak();
      }
    }
  }

  if (current) {
    chunks.push(`${current}${closingTags(openTags)}`);
  }

  return chunks.filter(Boolean);
}

export function toWhatsappJid(input: string): string {
  const clean = input.replace(/^whatsapp:/, '').trim();
  
  // Handle group JIDs - return as-is
  if (clean.endsWith('@g.us')) {
    return clean;
  }
  
  // Handle user JIDs with @s.whatsapp.net - strip device suffix if present
  if (clean.includes('@s.whatsapp.net')) {
    // Extract phone number, stripping device suffix like ":0"
    const atIndex = clean.indexOf('@');
    const localPart = clean.slice(0, atIndex);
    // Strip device suffix (e.g., "15551234567:0" -> "15551234567")
    const phone = localPart.includes(':') ? localPart.split(':')[0] : localPart;
    return `${phone}@s.whatsapp.net`;
  }
  
  // Handle other JIDs (like @lid) - return as-is
  if (clean.includes('@')) {
    return clean;
  }
  
  // Phone number - normalize and convert
  const digits = normalizeE164(clean).replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}
