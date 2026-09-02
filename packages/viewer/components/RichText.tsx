import type { RichText as RichTextSpans } from '@agentreplay/core';

/**
 * The only narrative renderer: styled spans from core → inline elements.
 * The viewer never generates narrative text.
 */
export default function RichText({ spans }: { spans: RichTextSpans }) {
  return (
    <>
      {spans.map((span, i) =>
        span.style === undefined ? (
          <span key={i}>{span.text}</span>
        ) : (
          <span key={i} className={`ar-rt--${span.style}`}>
            {span.text}
          </span>
        ),
      )}
    </>
  );
}
