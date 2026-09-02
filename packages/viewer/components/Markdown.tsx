import type { ReactNode } from 'react';

/**
 * Minimal markdown for transcript turns.
 *
 * Claude's turns arrive as markdown — fences, bullets, headings, inline code —
 * and showing them raw makes the evidence layer read like a diff of the
 * transcript rather than the transcript. This renders just the subset those
 * turns actually use, hand-rolled for the usual reasons: no dependency to
 * inline into the offline file, and no HTML injection surface — the input
 * only ever becomes React text nodes, never markup.
 *
 * Anything unrecognised falls through as literal text, which is the correct
 * failure mode for evidence: worst case the reader sees exactly what the
 * session contains.
 */
export default function Markdown({ text }: { text: string }) {
  return <div className="ar-md">{blocksOf(text).map(renderBlock)}</div>;
}

type Block =
  | { kind: 'code'; body: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string };

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*```/;

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (FENCE.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // the closing fence, if any
      blocks.push({ kind: 'code', body: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', text: heading[1] ?? '' });
      index += 1;
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = BULLET.exec(lines[index] ?? '');
        if (item === null) break;
        items.push(item[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    if (line.trimStart().startsWith('> ')) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('> ')) {
        quoted.push((lines[index] ?? '').trimStart().slice(2));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quoted.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // A paragraph: consecutive plain lines, line breaks preserved by CSS.
    const para: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || FENCE.test(current) || HEADING.test(current) || BULLET.test(current)) break;
      para.push(current);
      index += 1;
    }
    blocks.push({ kind: 'para', text: para.join('\n') });
  }

  return blocks;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'code':
      return (
        <pre key={key} className="ar-md-code mono">
          {block.body}
        </pre>
      );
    case 'heading':
      return (
        <p key={key} className="ar-md-heading">
          {inline(block.text)}
        </p>
      );
    case 'list':
      return (
        <ul key={key} className="ar-md-list">
          {block.items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <p key={key} className="ar-md-quote">
          {inline(block.text)}
        </p>
      );
    case 'para':
      return (
        <p key={key} className="ar-md-para">
          {inline(block.text)}
        </p>
      );
  }
}

/** Inline code and bold; everything else stays literal. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/).flatMap((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return [
        <code key={i} className="ar-md-inline mono">
          {part.slice(1, -1)}
        </code>,
      ];
    }
    return part.split(/(\*\*[^*\n]+\*\*)/).map((piece, j) =>
      piece.startsWith('**') && piece.endsWith('**') && piece.length > 4 ? (
        <strong key={`${i}-${j}`}>{piece.slice(2, -2)}</strong>
      ) : (
        piece
      ),
    );
  });
}
