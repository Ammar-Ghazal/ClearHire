import { describe, expect, it } from 'vitest';
import { formatPosting } from './posting-format.js';

const lever = [
  'Senior QA Engineer',
  'Remote (US)',
  'Engineering /',
  'Full-Time /',
  'Remote',
  'Apply for this job',
  'Benefits',
  '✅ Unlimited PTO',
  'Responsibilities',
  'Write tests using',
  'Playwright',
  'and keep them fast',
  'About us:',
  'We make food affordable.',
  'We are an equal opportunity employer and do not discriminate on the basis of any protected characteristic.',
  '$140,000 - $150,000 a year',
  'Role:',
  'Senior QA Engineer',
  'Apply for this job',
].join('\n');

describe('formatPosting', () => {
  it('reads header facts and orders sections regardless of source order', () => {
    const f = formatPosting({ text: lever, location: 'US, remote' });
    expect(f).toMatchObject({
      location: 'US',
      employmentType: 'Full-Time',
      workplace: 'Remote',
      salary: '$140,000 - $150,000 a year',
    });
    expect(f.sections.map((s) => s.key)).toEqual([
      'company',
      'responsibilities',
      'compensation',
      'legal',
    ]);
    expect(f.sections[1]!.blocks).toEqual([
      { kind: 'item', text: 'Write tests using Playwright and keep them fast' },
    ]);
    expect(f.sections[2]!.blocks).toEqual([{ kind: 'item', text: 'Unlimited PTO' }]);
  });

  it('splits &nbsp;-joined items and ignores amounts that are not pay', () => {
    const f = formatPosting({
      text: 'We raised $19m.\n\nQualifications:\nPython&nbsp;Go',
      location: 'Paris',
    });
    expect(f.salary).toBeNull();
    expect(f.workplace).toBeNull();
    expect(f.sections).toEqual([
      { key: 'overview', blocks: [{ kind: 'paragraph', text: 'We raised $19m.' }] },
      {
        key: 'requirements',
        blocks: [
          { kind: 'item', text: 'Python' },
          { kind: 'item', text: 'Go' },
        ],
      },
    ]);
  });
});
