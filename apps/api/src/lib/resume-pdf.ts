// Extracts text from a local, operator-supplied resume PDF. Runs only in the import script, never
// in the API process. Resume text is self-reported (or reconstructed) claims, never demonstrated
// skill.
import { extractText, getDocumentProxy } from 'unpdf';

export const RESUME_LIMITS = { maxBytes: 10 * 1024 * 1024, maxPages: 30 };
/** Below these, a PDF is probably scanned images; OCR is deferred, so it goes to manual review. */
const MIN_CHARS = 200;
const MIN_CHARS_PER_PAGE = 50;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export type ResumeExtraction =
  | { status: 'extracted'; text: string; pages: number }
  | {
      status: 'needs_review';
      reason: 'too_large' | 'too_many_pages' | 'unreadable' | 'likely_scanned';
      pages: number | null;
    };

export async function extractResume(bytes: Uint8Array): Promise<ResumeExtraction> {
  if (bytes.byteLength > RESUME_LIMITS.maxBytes) {
    return { status: 'needs_review', reason: 'too_large', pages: null };
  }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // pdf.js may take ownership of the buffer, so the caller's bytes are copied first.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const pages = pdf.numPages;
    if (pages > RESUME_LIMITS.maxPages) {
      return { status: 'needs_review', reason: 'too_many_pages', pages };
    }
    const { text } = await extractText(pdf, { mergePages: false });
    const chars = text.join('').replace(/\s/g, '').length;
    if (chars < MIN_CHARS || chars / Math.max(pages, 1) < MIN_CHARS_PER_PAGE) {
      return { status: 'needs_review', reason: 'likely_scanned', pages };
    }
    // Postgres text cannot hold NUL, and other control characters are extraction noise.
    const clean = text.map((t) => t.replace(CONTROL, '').trim()).join('\n\n');
    return { status: 'extracted', text: clean, pages };
  } catch {
    // Corrupt, encrypted or unsupported files: details stay out of stored state.
    return { status: 'needs_review', reason: 'unreadable', pages: null };
  } finally {
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}
