/**
 * Reading a JSON response from the browser, including when it isn't JSON.
 *
 * Every client component used to do `await res.json()` and trust it. That holds
 * for anything this application returns -- every route answers with
 * NextResponse.json even on failure -- but not for what the *platform* returns
 * in front of it. When a serverless function is killed for running past its time
 * limit, Vercel answers with a plain-text page:
 *
 *     An error occurred with this application.
 *     FUNCTION_INVOCATION_TIMEOUT
 *
 * `res.json()` then threw `Unexpected token 'A', "An error o"... is not valid
 * JSON`, which is what the user saw instead of "this took too long" -- the
 * parser's complaint about the error page, with the actual failure nowhere in
 * sight. The same applies to a 502 from the edge, a proxy's HTML error, or an
 * empty body.
 *
 * So: read the body as text, parse it if it parses, and otherwise synthesise the
 * same `{ error }` shape the routes use, carrying a message that names what
 * actually happened. Callers keep their existing `body.error` handling.
 */
export async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => '');
  if (text.trim()) {
    try {
      return JSON.parse(text);
    } catch {
      return { error: describe(res, text) };
    }
  }
  return res.ok ? {} : { error: describe(res, '') };
}

function describe(res: Response, text: string): string {
  // The gateway timeout is the one worth naming, because the recovery is
  // specific: the model's answer is cached by content, so a second attempt
  // usually returns immediately rather than repeating the wait.
  if (res.status === 504 || /FUNCTION_INVOCATION_TIMEOUT|Task timed out/i.test(text)) {
    return 'The server ran out of time on this request (the hosting limit). Long generations sometimes need a second attempt — the model output is cached, so a retry is usually much faster.';
  }
  if (res.status === 502 || res.status === 503) {
    return `The server was unavailable (${res.status}). Try again in a moment.`;
  }
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `The server returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''} instead of JSON${snippet ? `: ${snippet}` : '.'}`;
}
