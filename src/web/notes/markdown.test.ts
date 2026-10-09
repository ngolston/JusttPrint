import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, render, sanitizeUrl, type MarkdownNode } from './markdown';

describe('render', () => {
  it('never lets notes inject HTML or script (notes can come from imports, MCP and pulled metadata)', () => {
    const attacks = [
      '<img src=x onerror=alert(1)>',
      '<script>alert(1)</script>',
      '# <svg onload=alert(1)>',
      '- <iframe src="javascript:alert(1)">',
      '**<b onclick=alert(1)>x</b>**',
      '```\n</code><script>alert(1)</script>\n```',
      '> <a href="javascript:alert(1)">x</a>'
    ];
    // Every real tag must be one the renderer makes; only links have attributes, and only safe ones.
    const allowed = new Set(['p', 'br', 'strong', 'em', 's', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'a']);
    for (const attack of attacks) {
      const html = render(attack);
      for (const [, name, attributes] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
        expect(allowed.has(name.toLowerCase()), `${attack} → <${name}>`).toBe(true);
        if (name.toLowerCase() === 'a' && attributes.trim()) {
          expect(attributes, attack).toMatch(/^ href="(https?:|mailto:)[^"]*" target="_blank" rel="noopener noreferrer"$/);
        } else {
          expect(attributes.trim(), `${attack} → <${name}${attributes}>`).toBe('');
        }
      }
    }
  });

  it('links only to http, https and mailto, with the URL escaped', () => {
    expect(render('[x](javascript:alert(1))')).not.toContain('href');
    expect(render('[x](data:text/html,<script>alert(1)</script>)')).not.toContain('href');
    const quoted = render('[x](https://a.test/"onmouseover="alert(1))');
    expect(quoted).toContain('href="https://a.test/');
    expect(quoted).not.toMatch(/"\s*onmouseover=/);
  });

  it('keeps line breaks in plain notes', () => {
    expect(render('Test notes here')).toBe('<p>Test notes here</p>');
    expect(render('line one\nline two')).toBe('<p>line one<br>line two</p>');
    expect(render('')).toBe('');
  });

  it('formats bold, italic, strike and code', () => {
    expect(render('**bold** and *em*')).toBe('<p><strong>bold</strong> and <em>em</em></p>');
    expect(render('~~gone~~')).toBe('<p><s>gone</s></p>');
    expect(render('use `file_name`')).toBe('<p>use <code>file_name</code></p>');
  });

  it('leaves underscores in file names alone', () => {
    expect(render('model_v2_final')).toBe('<p>model_v2_final</p>');
  });

  it('renders lists, headings, quotes and rules', () => {
    const html = render('## Title\n\n- one\n- two\n\n1. first\n\n> quoted\n\n---');
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li></ol>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<hr>');
  });

  it('does not format fenced code', () => {
    expect(render('```\n**not bold**\n<script>\n```')).toBe('<pre><code>**not bold**\n&lt;script&gt;</code></pre>');
  });

  it('escapes HTML', () => {
    const html = render('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('allows http links and blocks javascript:', () => {
    const ok = render('[site](https://example.com/a?q=1&x=2)');
    expect(ok).toContain('href="https://example.com/a?q=1&amp;x=2"');
    expect(ok).toContain('rel="noopener noreferrer"');
    const bad = render('[x](javascript:alert(1))');
    expect(bad).not.toContain('<a ');
    expect(bad).toContain('javascript:alert(1)');
    expect(sanitizeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(sanitizeUrl('https://x.test/\u0001')).toBe('');
  });
});

function el(tag: string, children: (MarkdownNode | string)[] = [], attrs: { style?: MarkdownNode['style']; href?: string } = {}): MarkdownNode {
  const nodes = children.map((c) => (typeof c === 'string' ? { nodeType: 3, textContent: c, childNodes: [] } : c));
  const elements = nodes.filter((n) => n.nodeType === 1);
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: nodes,
    children: elements,
    style: attrs.style || {},
    getAttribute: (name) => (name === 'href' ? attrs.href || null : null),
    querySelector: (sel) =>
      elements.find((c) =>
        sel
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .includes(String(c.tagName))
      ) || null
  };
}

describe('htmlToMarkdown', () => {
  it('converts tags and inline styles', () => {
    expect(htmlToMarkdown(el('div', [el('b', ['bold']), ' and ', el('i', ['italic'])]))).toBe('**bold** and *italic*');
    expect(htmlToMarkdown(el('div', [el('span', ['styled bold'], { style: { fontWeight: 'bold' } })]))).toBe('**styled bold**');
    expect(htmlToMarkdown(el('div', [el('span', ['styled italic'], { style: { fontStyle: 'italic' } })]))).toBe('*styled italic*');
    expect(htmlToMarkdown(el('div', [el('span', ['styled strike'], { style: { textDecoration: 'line-through' } })]))).toBe('~~styled strike~~');
  });

  it('separates blocks and keeps headings, lists and links', () => {
    expect(htmlToMarkdown(null)).toBe('');
    expect(htmlToMarkdown(el('div', [el('p', ['Paragraph 1']), el('p', ['Paragraph 2'])]))).toBe('Paragraph 1\n\nParagraph 2');
    expect(htmlToMarkdown(el('div', [el('h2', ['Heading']), el('ul', [el('li', ['Item 1']), el('li', ['Item 2'])])]))).toBe('## Heading\n\n- Item 1\n- Item 2');
    expect(htmlToMarkdown(el('div', [el('a', ['site'], { href: 'https://example.com' }), el('a', ['bad'], { href: 'javascript:x' })]))).toBe(
      '[site](https://example.com/)bad'
    );
  });
});
