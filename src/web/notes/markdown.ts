/**
 * Markdown for model notes. Notes are stored as plain Markdown text (older plain notes still
 * read fine). HTML is escaped before any tags are added, and link URLs are limited to
 * http(s)/mailto. htmlToMarkdown turns the rich-text editor's HTML back into Markdown.
 */

export function escapeHtml(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The URL if it is http, https or mailto; otherwise ''. */
export function sanitizeUrl(url: string | null | undefined): string {
  const trimmed = String(url || '').trim();
  if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return '';
  return parsed.href;
}

function inline(raw: string): string {
  const re = /(`[^`\n]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([\s\S]+?)\*\*)|(__(.+?)__)|(~~([^~\n]+)~~)|(\*([^*\n]+?)\*)/g;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    out += escapeHtml(raw.slice(last, match.index));
    if (match[1]) {
      out += '<code>' + escapeHtml(match[1].slice(1, -1)) + '</code>';
    } else if (match[2]) {
      const safe = sanitizeUrl(match[4]);
      out += safe ? '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + inline(match[3]) + '</a>' : escapeHtml(match[2]);
    } else if (match[5]) {
      out += '<strong>' + inline(match[6]) + '</strong>';
    } else if (match[7]) {
      out += '<strong>' + inline(match[8]) + '</strong>';
    } else if (match[9]) {
      out += '<s>' + inline(match[10]) + '</s>';
    } else if (match[11]) {
      out += '<em>' + inline(match[12]) + '</em>';
    }
    last = match.index + match[0].length;
  }
  return out + escapeHtml(raw.slice(last));
}

function isBlockStart(line: string): boolean {
  return /^(```|#{1,6}\s|>\s?|\s*[-*]\s+|\s*\d+\.\s+|-{3,}\s*$|\*{3,}\s*$)/.test(line);
}

/** Markdown to safe HTML. */
export function render(markdown: string | null | undefined): string {
  const lines = String(markdown || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let html = '';
  let i = 0;

  const collect = (test: RegExp, strip: RegExp) => {
    const items: string[] = [];
    while (i < lines.length && test.test(lines[i])) {
      items.push(lines[i].replace(strip, ''));
      i += 1;
    }
    return items;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      html += '<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>';
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      html += '<hr>';
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      html += '<blockquote>' + render(collect(/^>\s?/, /^>\s?/).join('\n')) + '</blockquote>';
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      html +=
        '<ul>' +
        collect(/^\s*[-*]\s+/, /^\s*[-*]\s+/)
          .map((item) => '<li>' + inline(item) + '</li>')
          .join('') +
        '</ul>';
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      html +=
        '<ol>' +
        collect(/^\s*\d+\.\s+/, /^\s*\d+\.\s+/)
          .map((item) => '<li>' + inline(item) + '</li>')
          .join('') +
        '</ol>';
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    html += '<p>' + para.map(inline).join('<br>') + '</p>';
  }

  return html;
}

/** The parts of a DOM node htmlToMarkdown reads (so tests can pass plain objects). */
export interface MarkdownNode {
  nodeType: number;
  textContent?: string | null;
  tagName?: string;
  childNodes: ArrayLike<MarkdownNode> | MarkdownNode[];
  children?: ArrayLike<MarkdownNode> | MarkdownNode[];
  style?: Partial<Pick<CSSStyleDeclaration, 'fontWeight' | 'fontStyle' | 'textDecoration' | 'textDecorationLine'>>;
  getAttribute?: (name: string) => string | null;
  querySelector?: (selector: string) => MarkdownNode | null;
}

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr']);

const tagOf = (node: MarkdownNode) => String(node.tagName || '').toLowerCase();
const isBlockNode = (node: MarkdownNode | null | undefined) => !!node && node.nodeType === 1 && BLOCK_TAGS.has(tagOf(node));
const textOf = (node: MarkdownNode) => String(node.textContent || '').replace(/ /g, ' ');
const childNodes = (node: MarkdownNode) => Array.from(node.childNodes || []);
const childElements = (node: MarkdownNode) => Array.from(node.children || []);

function renderInlineNode(node: MarkdownNode | null | undefined): string {
  if (!node) return '';
  if (node.nodeType === 3) return textOf(node);
  if (node.nodeType !== 1) return '';

  const tag = tagOf(node);
  if (tag === 'br') return '\n';
  if (isBlockNode(node)) return blocksFromNode(node).join('\n');

  const inner = childNodes(node).map(renderInlineNode).join('');
  if (tag === 'code') return '`' + inner.replace(/`/g, '') + '`';
  if (tag === 'a') {
    const href = sanitizeUrl(node.getAttribute?.('href') || '');
    return href ? `[${inner}](${href})` : inner;
  }

  const styleAttr = node.getAttribute?.('style') || '';
  const style = node.style || {};
  const isBold =
    tag === 'strong' ||
    tag === 'b' ||
    style.fontWeight === 'bold' ||
    style.fontWeight === 'bolder' ||
    parseInt(String(style.fontWeight), 10) >= 600 ||
    /font-weight:\s*(bold|bolder|[6-9]00)/i.test(styleAttr);
  const isItalic =
    tag === 'em' || tag === 'i' || style.fontStyle === 'italic' || style.fontStyle === 'oblique' || /font-style:\s*(italic|oblique)/i.test(styleAttr);
  const isStrike =
    tag === 's' ||
    tag === 'strike' ||
    tag === 'del' ||
    !!style.textDecoration?.includes('line-through') ||
    !!style.textDecorationLine?.includes('line-through') ||
    /text-decoration(-line)?:\s*[^;]*line-through/i.test(styleAttr);
  if (!isBold && !isItalic && !isStrike) return inner;

  const leading = inner.match(/^\s*/)?.[0] || '';
  const trailing = inner.match(/\s*$/)?.[0] || '';
  const trimmed = inner.slice(leading.length, inner.length - trailing.length);
  if (!trimmed) return inner;

  let wrapped = trimmed;
  if (isBold) wrapped = `**${wrapped}**`;
  if (isItalic) wrapped = `*${wrapped}*`;
  if (isStrike) wrapped = `~~${wrapped}~~`;
  return leading + wrapped + trailing;
}

const renderInline = (container: MarkdownNode) => childNodes(container).map(renderInlineNode).join('');

function blocksFromNode(node: MarkdownNode | null | undefined): string[] {
  if (!node) return [];
  if (node.nodeType === 3) {
    const text = textOf(node);
    return text.trim() ? [text] : [];
  }
  if (node.nodeType !== 1) return [];

  const tag = tagOf(node);
  if (tag === 'pre') {
    const code = String(node.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n$/, '');
    return ['```\n' + code + '\n```'];
  }
  if (tag === 'hr') return ['---'];
  if (tag === 'ul' || tag === 'ol') {
    const items = childElements(node)
      .filter((el) => tagOf(el) === 'li')
      .map((li, index) => {
        const line = renderInline(li).replace(/\n+/g, ' ').trim();
        return tag === 'ol' ? `${index + 1}. ${line}` : `- ${line}`;
      });
    return items.length ? [items.join('\n')] : [];
  }
  if (tag === 'blockquote') {
    const quoted = convertChildBlocks(node)
      .join('\n\n')
      .split('\n')
      .map((l) => '> ' + l)
      .join('\n');
    return quoted ? [quoted] : [];
  }
  if (/^h[1-6]$/.test(tag)) {
    const listChild = node.querySelector?.('ul, ol');
    if (listChild) return blocksFromNode(listChild);
    const text = renderInline(node).trim();
    return text ? ['#'.repeat(Number(tag[1])) + ' ' + text] : [];
  }
  if (childElements(node).some(isBlockNode)) return convertChildBlocks(node);
  const inlineText = renderInline(node).trim();
  return inlineText ? [inlineText] : [];
}

function convertChildBlocks(container: MarkdownNode): string[] {
  const blocks: string[] = [];
  let inlines: MarkdownNode[] = [];
  const flush = () => {
    const text = inlines
      .map(renderInlineNode)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text) blocks.push(text);
    inlines = [];
  };
  for (const child of childNodes(container)) {
    if (isBlockNode(child)) {
      flush();
      blocks.push(...blocksFromNode(child));
    } else {
      inlines.push(child);
    }
  }
  flush();
  return blocks.filter(Boolean);
}

/** The rich-text editor's HTML back to Markdown. */
export function htmlToMarkdown(root: MarkdownNode | null | undefined): string {
  if (!root) return '';
  return convertChildBlocks(root).join('\n\n').trim();
}
