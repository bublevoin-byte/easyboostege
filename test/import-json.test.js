import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const importerPath = fileURLToPath(new URL('../scripts/import-json.js', import.meta.url));

function importerEnvironment(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    APP_URL: 'http://127.0.0.1:3000',
    VK_ID_MODE: 'disabled',
    DATABASE_PROVIDER: 'file',
    DATABASE_URL: '',
    ...overrides,
  };
}

function runImporter(source, arguments_ = [], env = importerEnvironment()) {
  return spawnSync(process.execPath, [importerPath, source, ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env,
  });
}

function importFixture(suffix = 'dry') {
  const legacyUsername = `legacy_import_${suffix}`;
  const providerUsername = `learner_import_${suffix}`;
  const forbiddenSecret = `must-never-be-imported-${suffix}`;
  return {
    forbiddenSecret,
    legacyUsername,
    providerUsername,
    snapshot: {
      users: {
        [legacyUsername]: {
          hash: 'legacy-password-hash', role: 'student', trial_used: true,
          created: Date.parse('2026-08-20T08:00:00.000Z'),
        },
        [providerUsername]: {
          identity_managed: true, display_name: 'Мария Импорт', role: 'student',
          created: Date.parse('2026-08-21T08:00:00.000Z'),
        },
      },
      learner_identities: [{
        provider: 'vk', subject: `vk-${suffix}`, username: providerUsername,
        created_at: '2026-08-21T08:00:00.000Z', updated_at: '2026-08-22T08:00:00.000Z',
        access_token: forbiddenSecret,
      }],
      progress: {
        [legacyUsername]: { learned: 3 },
        [providerUsername]: { learned: 7 },
      },
      oauth_auth_transactions: {
        ['a'.repeat(64)]: { verifier_sealed: forbiddenSecret },
      },
    },
  };
}

class RecordingImportClient {
  constructor() {
    this.queries = [];
  }

  async query(text, parameters = []) {
    this.queries.push({ text: String(text), parameters });
    return { rowCount: 1, rows: [] };
  }
}

class FailingIdentityClient extends RecordingImportClient {
  async query(text, parameters = []) {
    const result = await super.query(text, parameters);
    if (/INSERT INTO learner_identities/u.test(String(text))) {
      throw new Error('simulated identity insert failure');
    }
    return result;
  }
}

test('JSON import dry-run preserves legacy and provider-managed account coverage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-json-dry-'));
  try {
    const source = path.join(directory, 'data.json');
    const { snapshot } = importFixture();
    await fs.writeFile(source, JSON.stringify(snapshot), 'utf8');

    const result = runImporter(source, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      dryRun: true,
      source,
      users: 2,
      learnerIdentities: 1,
      progress: 2,
      skipped: [],
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('JSON import writes provider identity and progress in the same transaction without OAuth payloads', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot, legacyUsername, providerUsername } = importFixture('real');
  const client = new RecordingImportClient();

  const report = await importJsonData(snapshot, { source: 'fixture.json', client });

  assert.deepEqual(report, {
    source: 'fixture.json', users: 2, learnerIdentities: 1, progress: 2, skipped: [],
  });
  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(client.queries.at(-1).text, 'COMMIT');
  const providerUser = client.queries.find(({ text, parameters }) => (
    /INSERT INTO users/u.test(text) && parameters[0] === providerUsername
  ));
  assert.deepEqual(providerUser.parameters.slice(0, 5), [
    providerUsername, null, null, true, 'Мария Импорт',
  ]);
  const legacyUser = client.queries.find(({ text, parameters }) => (
    /INSERT INTO users/u.test(text) && parameters[0] === legacyUsername
  ));
  assert.deepEqual(legacyUser.parameters.slice(0, 5), [
    legacyUsername, 'legacy-password-hash', null, false, null,
  ]);
  const identity = client.queries.find(({ text }) => /INSERT INTO learner_identities/u.test(text));
  assert.deepEqual(identity.parameters.slice(0, 3), ['vk', 'vk-real', providerUsername]);
  assert.equal(client.queries.filter(({ text }) => /INSERT INTO user_progress/u.test(text)).length, 2);
  assert.doesNotMatch(JSON.stringify(client.queries), /must-never-be-imported|oauth_auth_transactions/u);
});

test('JSON import rolls back the complete snapshot when provider identity persistence fails', async () => {
  const { importJsonData } = await import('../scripts/import-json.js');
  const { snapshot } = importFixture('rollback');
  const client = new FailingIdentityClient();

  await assert.rejects(
    importJsonData(snapshot, { source: 'rollback.json', client }),
    /simulated identity insert failure/u,
  );
  assert.equal(client.queries[0].text, 'BEGIN');
  assert.equal(client.queries.at(-1).text, 'ROLLBACK');
  assert.equal(client.queries.some(({ text }) => text === 'COMMIT'), false);
});

test('JSON import CLI restores legacy and provider accounts in PostgreSQL without OAuth secrets', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const suffix = `pg_${process.pid}_${Date.now()}`;
  const fixture = importFixture(suffix);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-import-json-pg-'));
  const source = path.join(directory, 'data.json');
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await fs.writeFile(source, JSON.stringify(fixture.snapshot), 'utf8');
    const result = runImporter(source, [], importerEnvironment({
      DATABASE_PROVIDER: 'postgres',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      dryRun: false,
      source,
      users: 2,
      learnerIdentities: 1,
      progress: 2,
      skipped: [],
    });

    const accounts = await client.query(
      `SELECT username, password_hash, identity_managed, display_name
       FROM users WHERE username = ANY($1::text[]) ORDER BY username`,
      [[fixture.legacyUsername, fixture.providerUsername]],
    );
    assert.equal(accounts.rowCount, 2);
    const legacy = accounts.rows.find(({ username }) => username === fixture.legacyUsername);
    assert.equal(legacy.password_hash, 'legacy-password-hash');
    assert.equal(legacy.identity_managed, false);
    const provider = accounts.rows.find(({ username }) => username === fixture.providerUsername);
    assert.equal(provider.password_hash, null);
    assert.equal(provider.identity_managed, true);
    assert.equal(provider.display_name, 'Мария Импорт');

    const identity = await client.query(
      `SELECT provider, subject, username FROM learner_identities
       WHERE provider = $1 AND subject = $2`,
      ['vk', `vk-${suffix}`],
    );
    assert.deepEqual(identity.rows, [{
      provider: 'vk', subject: `vk-${suffix}`, username: fixture.providerUsername,
    }]);
    const progress = await client.query(
      'SELECT username, data FROM user_progress WHERE username = ANY($1::text[])',
      [[fixture.legacyUsername, fixture.providerUsername]],
    );
    assert.equal(progress.rowCount, 2);
    assert.deepEqual(progress.rows.find(({ username }) => (
      username === fixture.providerUsername
    )).data, { learned: 7 });
    const oauth = await client.query(
      'SELECT 1 FROM oauth_auth_transactions WHERE verifier_sealed = $1',
      [fixture.forbiddenSecret],
    );
    assert.equal(oauth.rowCount, 0);
  } finally {
    if (connected) {
      try {
        await client.query('DELETE FROM users WHERE username = ANY($1::text[])', [
          [fixture.legacyUsername, fixture.providerUsername],
        ]);
      } finally {
        await client.end();
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
