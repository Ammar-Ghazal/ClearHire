import { describe, expect, it } from 'vitest';
import { extractResume, RESUME_LIMITS } from './resume-pdf.js';
import { makePdf, resumeText } from './test-pdf.js';

describe('extractResume', () => {
  it('extracts text from every page and leaves the source bytes unchanged', async () => {
    const pdf = makePdf([resumeText('Ada'), resumeText('Grace')]);
    const before = pdf.slice();
    const result = await extractResume(pdf);
    expect(result).toMatchObject({ status: 'extracted', pages: 2 });
    if (result.status !== 'extracted') throw new Error('unreachable');
    expect(result.text).toContain('Ada built and maintained service number 1.');
    expect(result.text).toContain('Grace built and maintained service number 12.');
    expect(pdf).toEqual(before);
  });

  it('flags a PDF without a text layer as likely scanned', async () => {
    expect(await extractResume(makePdf(['', '']))).toEqual({
      status: 'needs_review',
      reason: 'likely_scanned',
      pages: 2,
    });
  });

  it('flags a PDF whose text is too thin for its page count', async () => {
    const pages = [resumeText('Ada'), ...Array.from({ length: 9 }, () => '')];
    expect(await extractResume(makePdf(pages))).toMatchObject({ reason: 'likely_scanned' });
  });

  it('flags corrupt bytes as unreadable without exposing details', async () => {
    const result = await extractResume(new TextEncoder().encode('%PDF-1.4 not really a pdf'));
    expect(result).toEqual({ status: 'needs_review', reason: 'unreadable', pages: null });
  });

  it('enforces the file-size and page limits before extracting', async () => {
    const big = new Uint8Array(RESUME_LIMITS.maxBytes + 1);
    expect(await extractResume(big)).toMatchObject({ reason: 'too_large' });
    const many = makePdf(Array.from({ length: RESUME_LIMITS.maxPages + 1 }, () => resumeText('A')));
    expect(await extractResume(many)).toMatchObject({ reason: 'too_many_pages', pages: 31 });
  });
});
