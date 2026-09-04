import pg from 'pg';
import './env.mjs';
import argon2 from 'argon2';

/**
 * Demo accounts for development.
 *
 * Deliberately small: enough to exercise search, friendship and blocking
 * without pretending to be production data. Every password is the same and
 * obviously fake, so nobody mistakes these for real accounts.
 */
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }

const PASSWORD = 'snapx-demo-2026';
const PEOPLE = [
  { username: 'ayesha',  name: 'Ayesha Siddiqui', email: 'ayesha@snapx.test',  dob: '1998-04-12', bio: 'Photographer. Karachi.' },
  { username: 'bilal',   name: 'Bilal Ahmed',     email: 'bilal@snapx.test',   dob: '1996-11-03', bio: 'Coffee, code, cricket.' },
  { username: 'hina',    name: 'Hina Raza',       email: 'hina@snapx.test',    dob: '2000-07-21', bio: '' },
  { username: 'usman',   name: 'Usman Tariq',     email: 'usman@snapx.test',   dob: '1999-01-30', bio: 'Sunsets and street food.' },
  { username: 'zara',    name: 'Zara Khan',       email: 'zara@snapx.test',    dob: '2001-09-08', bio: 'Design student.' },
];

const client = new pg.Client(url);
await client.connect();

const existing = await client.query('SELECT count(*)::int n FROM users');
if (existing.rows[0].n > 0) {
  console.error('This database already has users. Run db:reset to rebuild from scratch.');
  process.exit(1);
}

const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const ids = {};

await client.query('BEGIN');
for (const p of PEOPLE) {
  const { rows } = await client.query(
    `INSERT INTO users (username, email, password_hash, date_of_birth, email_verified_at)
     VALUES ($1,$2,$3,$4,now()) RETURNING id`,
    [p.username, p.email, hash, p.dob]);
  ids[p.username] = rows[0].id;
  await client.query(`INSERT INTO profiles (user_id, display_name, bio) VALUES ($1,$2,$3)`,
    [rows[0].id, p.name, p.bio || null]);
  await client.query(`INSERT INTO privacy_settings (user_id) VALUES ($1)`, [rows[0].id]);
  await client.query(`INSERT INTO notification_settings (user_id) VALUES ($1)`, [rows[0].id]);
}

// A small friend graph, canonically ordered as the CHECK constraint requires.
const friend = async (a, b) => {
  const [x, y] = [ids[a], ids[b]].sort();
  await client.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2)`, [x, y]);
};
await friend('ayesha', 'bilal');
await friend('ayesha', 'hina');
await friend('bilal', 'usman');

// One pending request and one block, so both states are testable immediately.
await client.query(
  `INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ($1,$2)`,
  [ids.zara, ids.ayesha]);
await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)`,
  [ids.hina, ids.usman]);

await client.query('COMMIT');

console.log(`Seeded ${PEOPLE.length} users, 3 friendships, 1 pending request, 1 block.`);
console.log(`\nSign in with any username below — password: ${PASSWORD}\n`);
for (const p of PEOPLE) console.log(`  ${p.username.padEnd(8)} ${p.name}`);
console.log(`\n  hina has blocked usman — they should be invisible to each other.`);
await client.end();
