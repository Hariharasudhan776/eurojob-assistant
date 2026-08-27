import mammoth from 'mammoth';

/**
 * Getting the text out of a CV file.
 *
 * This is the first half of replacing the JSON upload. Asking a user to
 * hand-write their profile was defensible in principle and indefensible in
 * practice: the candidate's own profile is 690 lines and 318 hand-typed skill
 * fields, and nobody who has not read the schema will ever produce one. It was
 * the single thing standing between this app and anyone else using it.
 *
 * What this file does NOT do is decide anything. It returns the words that were
 * in the document and nothing else -- no dates parsed, no skills inferred, no
 * structure guessed. Reading is separated from interpreting on purpose: text
 * extraction is deterministic and can be trusted, interpretation is a model call
 * and cannot, and keeping them apart is what lets the interpretation be reviewed
 * before anything is saved.
 *
 * Both libraries are pure JavaScript. `unpdf` in particular is used instead of
 * the usual pdf-parse because it needs no native canvas binding, which is what
 * makes it work unchanged on a serverless host.
 */

export const MAX_CV_BYTES = 8 * 1024 * 1024;

/** Below this, the file parsed but produced nothing worth sending to a model. */
const MIN_USEFUL_CHARS = 200;

export type CvKind = 'pdf' | 'docx' | 'text';

export interface ExtractResult {
  text: string;
  kind: CvKind;
  /** Problems worth telling the user about, in plain language. */
  errors: string[];
  /** Pages, where the format has them. Shown so a truncated read is visible. */
  pages: number | null;
}

function detectKind(filename: string, bytes: Uint8Array): CvKind | null {
  const name = filename.toLowerCase();

  // Magic numbers first: a file's extension is a claim, its header is evidence.
  // "%PDF" and "PK" (a zip, which is what a .docx is) are unambiguous.
  const header = String.fromCharCode(...bytes.slice(0, 4));
  if (header.startsWith('%PDF')) return 'pdf';
  if (header.startsWith('PK') && name.endsWith('.docx')) return 'docx';

  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.txt') || name.endsWith('.md')) return 'text';

  // .doc is the old binary Word format and is not readable by mammoth.
  return null;
}

export async function extractCvText(filename: string, bytes: Uint8Array): Promise<ExtractResult> {
  const errors: string[] = [];

  if (bytes.byteLength === 0) {
    return { text: '', kind: 'text', errors: ['That file is empty.'], pages: null };
  }
  if (bytes.byteLength > MAX_CV_BYTES) {
    return {
      text: '',
      kind: 'text',
      errors: [`That file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB. The limit is 8MB.`],
      pages: null,
    };
  }

  const kind = detectKind(filename, bytes);
  if (!kind) {
    return {
      text: '',
      kind: 'text',
      errors: [
        'That file type cannot be read. Upload a PDF, a Word .docx, or a plain text file. ' +
          'The old binary .doc format is not supported — open it in Word and "Save As" .docx.',
      ],
      pages: null,
    };
  }

  try {
    if (kind === 'text') {
      const text = new TextDecoder().decode(bytes);
      return finish(text, kind, errors, null);
    }

    if (kind === 'docx') {
      // mammoth wants a Node Buffer, and this may run where only the Web types
      // exist, so the conversion is explicit rather than assumed.
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      for (const message of result.messages) {
        if (message.type === 'error') errors.push(message.message);
      }
      return finish(result.value, kind, errors, null);
    }

    // Imported lazily: it pulls in a sizeable PDF stack, and most requests to
    // this application never touch it.
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(bytes);
    // mergePages returns one string for the whole document; without it the
    // result is an array per page and headings split across page breaks.
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return finish(text, kind, errors, totalPages);
  } catch (err) {
    return {
      text: '',
      kind,
      errors: [
        `That ${kind.toUpperCase()} could not be read (${err instanceof Error ? err.message : 'unknown error'}). ` +
          'If it is a scanned document it contains images rather than text, and will need to be re-saved from the original.',
      ],
      pages: null,
    };
  }
}

function finish(raw: string, kind: CvKind, errors: string[], pages: number | null): ExtractResult {
  // Collapse the ragged whitespace PDF extraction produces, without destroying
  // the line structure a model needs to tell a heading from a bullet.
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  if (text.length < MIN_USEFUL_CHARS) {
    errors.push(
      'Almost no text came out of that file. If it is a scanned CV or an exported image, ' +
        'the words are pixels rather than characters and cannot be read. Re-save it from the original document.'
    );
  }

  return { text, kind, errors, pages };
}
