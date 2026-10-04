// Turning HTTP and connection failures into messages the user can act on.
// Shared by every adapter.

/** Pulls the message out of an error body ({"error":{"message":…}} or Ollama's {"error":"…"}). */
export async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    return (typeof body.error === "string" ? body.error : body.error?.message) ?? text;
  } catch {
    return text || response.statusText;
  }
}

/** Turns a status code into something the user can act on. */
export function httpError(status: number, detail: string, label: string, model: string): string {
  const reason = (() => {
    switch (status) {
      case 401:
      case 403:
        return `${label} rejected the API key. Run /setup to enter a new one.`;
      case 402:
        return `Your ${label} account is out of credits.`;
      case 404:
        return `Model "${model}" wasn't found on ${label}. Pick another with /model.`;
      case 429:
        return `Rate limited by ${label}. Wait a moment and try again.`;
      default:
        return status >= 500 ? `${label} is having trouble (${status}). Try again shortly.` : `${label} returned ${status}.`;
    }
  })();
  return detail ? `${reason}\n${detail}` : reason;
}

export function unreachable(label: string, baseUrl: string, err: unknown, hint?: string): string {
  return `Can't reach ${label} at ${new URL(baseUrl).origin}.${hint ? ` ${hint}` : ""} (${(err as Error).message})`;
}
