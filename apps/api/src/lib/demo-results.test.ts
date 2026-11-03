import { describe, expect, it } from 'vitest';
import { resumeTitle } from './demo-results.js';

describe('resumeTitle', () => {
  it('takes the headline under the name', () => {
    expect(resumeTitle('Viet Nguyen\nAI Data Engineer\nOrange County, CA')).toBe('AI Data Engineer');
    expect(resumeTitle('Ismael\n Software Engineer & Tech Lead \nRuby')).toBe(
      'Software Engineer & Tech Lead',
    );
  });

  it('leaves missing or ambiguous headlines unspecified', () => {
    for (const text of [
      null,
      '',
      'Ada',
      'Ada\nBavaria, Germany',
      'Ada\nSoftware Engineering Student | Full-Stack, Mobile & IoT Developer',
      'Ada\nSoftware Engineer March 2023 - Present',
      'Ada\ninquiries@ada.dev | github.com/ada',
      'Ada | Public-source demo reconstruction | 1\nAda\nPublic-source professional profile',
    ]) {
      expect(resumeTitle(text)).toBeNull();
    }
  });
});
