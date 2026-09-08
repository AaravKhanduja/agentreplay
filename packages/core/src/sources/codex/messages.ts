/**
 * What a message looks like in a Codex rollout — the one place that knows.
 *
 * Codex has written this two ways. Older versions put the kind on the payload
 * (`user_message`) with the text in `message`; current ones wrap everything in
 * `item_completed` and move the kind a level down, into `item.type`, spelled
 * `UserMessage`. Both are alive in one sessions directory, so this recognizes
 * both rather than switching on a version.
 *
 * It lives apart from the parser because discovery counts messages too, and the
 * two encodings of this knowledge drifted: the parser and `scanBody` each had
 * their own copy of the old shape, so when the format moved, sessions stopped
 * being discovered at all while the tool calls in them still read fine.
 */

import type { Turn } from '../../types.js';

export interface CodexMessage {
  role: Turn['role'];
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The text of a content block list.
 *
 * Any block carrying a string `text` counts, deliberately: a user's blocks are
 * typed `text` and an agent's are typed `Text`, so filtering on the block type
 * would silently drop one side of the conversation and look half-working.
 */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .filter((text) => text !== '')
    .join('\n\n');
}

/**
 * The message an `event_msg` payload carries, or null if it carries none.
 *
 * Null is the answer for every other kind of event — token counts, task
 * boundaries, patch results — so a caller can treat it as "is this a message".
 */
export function codexMessage(payload: Record<string, unknown>): CodexMessage | null {
  const type = payload['type'];

  if (type === 'user_message' || type === 'agent_message') {
    const text = blockText(payload['message']);
    if (text.trim() === '') return null;
    return { role: type === 'user_message' ? 'user' : 'assistant', text };
  }

  if (type === 'item_completed') {
    const item = isRecord(payload['item']) ? payload['item'] : null;
    if (item === null) return null;
    const itemType = item['type'];
    if (itemType !== 'UserMessage' && itemType !== 'AgentMessage') return null;
    const text = blockText(item['content']);
    if (text.trim() === '') return null;
    return { role: itemType === 'UserMessage' ? 'user' : 'assistant', text };
  }

  return null;
}
