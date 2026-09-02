/**
 * Reading assistant prose.
 *
 * Everything AgentReplay says about meaning comes from sentences the session
 * actually contains, so the splitting rules matter: a conclusion that inherits
 * the preamble in front of it scores as a preamble, and a sentence broken at
 * "e.g." is quoted as a fragment.
 */

/** Prose only: code blocks, bullets, headings and markdown emphasis removed. */
export function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|(?<=\w)\*|\*(?=\w)/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !/^([#>|]|[-*+]\s|\d+[.)]\s)/.test(trimmed);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREVIATION = /\b(e\.g|i\.e|etc|vs|approx|cf|fig|no|al)\.$/i;

export function splitSentences(text: string): string[] {
  return (
    text
      // Colons end clauses in assistant prose ("…firewall rule: The script is
      // written and typechecks, but I'm blocked…"). Without splitting there, a
      // conclusion inherits the preamble in front of it.
      .split(/(?<=[.!?:])\s+(?=[A-Z"“'(])/)
      // "e.g. Foo" is one sentence, not two — rejoin what the split broke.
      .reduce<string[]>((sentences, part) => {
        const previous = sentences[sentences.length - 1];
        if (previous !== undefined && ABBREVIATION.test(previous)) {
          sentences[sentences.length - 1] = `${previous} ${part}`;
          return sentences;
        }
        sentences.push(part);
        return sentences;
      }, [])
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== '')
  );
}

/** Clip at a sentence boundary where possible, a word boundary otherwise. */
export function clipSentence(text: string, maxChars: number, minChars = 40): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  if (lastStop > minChars) return cut.slice(0, lastStop + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > minChars ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
