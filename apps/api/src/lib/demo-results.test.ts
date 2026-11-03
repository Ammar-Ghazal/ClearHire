import { describe, expect, it } from 'vitest';
import { resumeTitle } from './demo-results.js';

describe('resumeTitle', () => {
  it('takes the headline under the name', () => {
    expect(resumeTitle('Viet Nguyen', 'Viet Nguyen\nAI Data Engineer\nOrange County, CA')).toBe(
      'AI Data Engineer',
    );
    expect(resumeTitle('Ismael Marin', 'ISMAEL G. MARÍN\n Software Engineer & Tech Lead \n')).toBe(
      'Software Engineer & Tech Lead',
    );
  });

  it('takes a title written after the name on the first line', () => {
    expect(resumeTitle('Gaël Varoquaux', 'Gaël Varoquaux Research Director, Inria\nPositions')).toBe(
      'Research Director, Inria',
    );
  });

  it("keeps the first part of a '|' headline", () => {
    const text = 'SAHIL AUKHAJ\nSoftware Engineering Student | Full-Stack, Mobile & IoT Developer';
    expect(resumeTitle('Sahil Aukhaj', text)).toBe('Software Engineering Student');
  });

  it('leaves missing or ambiguous headlines unspecified', () => {
    for (const text of [
      null,
      '',
      'Ada',
      'Ada\nBavaria, Germany',
      'Ada\nWeb Standards | Software Engineering | Human-Computer Interaction',
      'Ada\nSoftware Engineer March 2023 - Present',
      'Ada\ninquiries@ada.dev | github.com/ada',
      'Ada\nlinkedin.com/in/ada Cloud Platform Engineer Portfolio: ada.fyi',
      'Ada | Public-source demo reconstruction | 1\nAda\nPublic-source professional profile',
    ]) {
      expect(resumeTitle('Ada', text)).toBeNull();
    }
  });
});
