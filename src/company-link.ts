import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * What every call site says when the chat turns out not to be linked. Sent
 * plain (see the parse-mode convention in formatters.ts): it's static copy
 * with no formatting need, and plain text can't fail to parse.
 */
export const NOT_LINKED_MESSAGE = "This chat is not linked to a Paperclip company. Use /connect first.";

export function chatLinkStateKey(chatId: string): string {
  return `chat_${chatId}`;
}

type ChatLinkMapping = { companyId?: string; companyName?: string; linkedAt?: string };

export type CompanyLookupResult =
  | { linked: true; companyId: string; companyName?: string }
  | { linked: false };

/**
 * The company a chat is linked to, or not-linked. Never throws: commands.ts,
 * worker.ts, and acp-bridge.ts used to each carry their own throwing variant
 * of this lookup, and worker.ts's `handleUpdate` needed a second function
 * just to catch the throw — a throw escaping `handleUpdate` stops the
 * polling offset advancing, so Telegram redelivers the same update forever
 * and the poller wedges for every chat. Returning a result instead of
 * throwing makes that failure unrepresentable rather than defended against.
 *
 * `companyName` is accepted as a fallback companyId because chats linked by
 * older versions of /connect only stored a name, not an id.
 */
export async function lookupCompanyLink(ctx: PluginContext, chatId: string): Promise<CompanyLookupResult> {
  let mapping: ChatLinkMapping | null;
  try {
    mapping = await ctx.state.get({
      scopeKind: "instance",
      stateKey: chatLinkStateKey(chatId),
    }) as ChatLinkMapping | null;
  } catch {
    return { linked: false };
  }

  const companyId = mapping?.companyId ?? mapping?.companyName;
  if (!companyId) return { linked: false };
  return { linked: true, companyId, companyName: mapping?.companyName };
}
