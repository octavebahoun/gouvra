import { MAILPIT_URL } from "./env";

type MessageSummary = { ID: string; Subject: string; Created: string; To: { Address: string }[] };

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mailpit ${response.status} for ${url}`);
  return (await response.json()) as T;
}

/** Messages sent to `address`, newest first (Mailpit search API). */
export async function messagesTo(address: string): Promise<MessageSummary[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const result = await json<{ messages: MessageSummary[] }>(
    `${MAILPIT_URL}/api/v1/search?query=${query}&limit=50`,
  );
  return result.messages;
}

async function messageText(id: string): Promise<string> {
  const message = await json<{ Text: string; HTML: string }>(`${MAILPIT_URL}/api/v1/message/${id}`);
  return `${message.Text}\n${message.HTML}`;
}

/**
 * Wait for an e-mail to `address` containing a link to `path` (e.g. "/verify-email") and return
 * that link's path + fragment (`/verify-email#token=…`), ready to open on any base URL.
 * Only messages received after `since` are considered (resends supersede older links).
 */
export async function waitForLink(
  address: string,
  path: string,
  { since = 0, timeoutMs = 20_000 }: { since?: number; timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(
    `https?://[^\\s"'<>]+(${path.replace("/", "\\/")}#token=[A-Za-z0-9_-]+)`,
  );
  while (Date.now() < deadline) {
    const messages = (await messagesTo(address)).filter(
      (m) => new Date(m.Created).getTime() >= since - 1000,
    );
    for (const message of messages) {
      const match = pattern.exec(await messageText(message.ID));
      if (match?.[1]) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`No e-mail with a ${path} link reached ${address} within ${timeoutMs} ms`);
}

/** The token carried by a link returned by waitForLink. */
export function tokenOf(link: string): string {
  const token = new URLSearchParams(link.split("#")[1] ?? "").get("token");
  if (!token) throw new Error(`No token in ${link}`);
  return token;
}
