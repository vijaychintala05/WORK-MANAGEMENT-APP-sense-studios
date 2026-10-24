import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { reviewRoutingTestTarget, verifyReviewRoutingTestDatabase } from '../../apps/api/dist/review-routing-test-target.js';
const root = resolve('.');
const binding = reviewRoutingTestTarget(root, 'DATABASE_URL');
assert.equal(resolve(process.argv[2] ?? ''), resolve(root, binding.state.environment.S27_TEST_ENV_FILE));
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = await import('../../apps/api/dist/app.module.js');
const { DatabaseService } = await import('../../apps/api/dist/database.service.js');
const { AutomationService } = await import('../../apps/api/dist/automation.service.js');
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const database = app.get(DatabaseService);
  await verifyReviewRoutingTestDatabase(database.prisma, binding);
  await database.check();
  console.log(JSON.stringify(await app.get(AutomationService).runBatch()));
} finally { await app.close(); }
