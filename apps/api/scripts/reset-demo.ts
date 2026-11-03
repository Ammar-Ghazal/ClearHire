// Resets demo activity: answers, Discussion, interviews, offers, seeker preferences and priority
// changes. Imported fixtures and saved analyses stay, so scores are unchanged and nothing is paid.
//   pnpm --filter @clearhire/api demo:reset
import { db, pool } from '../src/db/client.js';
import { demoPreferences, demoRelationships, jobPriorityOverrides } from '../src/db/schema.js';

try {
  await db.transaction(async (tx) => {
    // Messages, interviews, slots and offers cascade from relationships.
    await tx.delete(demoRelationships);
    await tx.delete(demoPreferences);
    await tx.delete(jobPriorityOverrides);
  });
  console.log('Demo activity reset. Fixtures and saved analyses were kept.');
} finally {
  await pool.end();
}
