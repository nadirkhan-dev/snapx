-- ============================================================================
-- SNAPX — schema
--
-- Phase 1 implements identity: users, profiles, devices, sessions, refresh
-- tokens. The remaining tables from spec §31 are created now because foreign
-- keys are far cheaper to declare up front than to retrofit, and an empty table
-- costs nothing.
--
-- Conventions:
--   * UUIDv4 primary keys everywhere (spec §31). Sequential ids leak volume and
--     let anyone enumerate users by counting.
--   * `citext` for email and username so uniqueness is case-insensitive without
--     lower() on every lookup.
--   * Soft delete via `deleted_at` on anything a user can remove but moderation
--     may later need to inspect.
--   * timestamptz throughout, never `timestamp`. A social app crosses time
--     zones by definition.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================================================ IDENTITY ====

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        citext UNIQUE NOT NULL
                    CHECK (username ~ '^[a-z0-9_.]{3,24}$'),
  email           citext UNIQUE,
  phone           text UNIQUE,
  password_hash   text NOT NULL,
  -- Verification is per-channel: someone can sign up by phone and add an email
  -- later, and each is proven separately.
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  date_of_birth   date NOT NULL,
  -- Moderation state (spec §29). `suspended_until` is nullable for permanence.
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','banned','deactivated')),
  suspended_until timestamptz,
  is_admin        boolean NOT NULL DEFAULT false,
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  -- At least one contactable identifier, or the account can never be recovered.
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX ON users (last_seen_at DESC);

COMMENT ON COLUMN users.date_of_birth IS
  'Required at signup for age gating. Stored as a date, never an age — an age
   is wrong the day after you compute it.';

CREATE TABLE profiles (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  bio           text CHECK (length(bio) <= 160),
  avatar_media_id uuid,          -- FK added after `media` exists
  -- Denormalised counter. Kept correct by trigger rather than recounted on
  -- every profile view: friend counts are read constantly and written rarely.
  friend_count  int NOT NULL DEFAULT 0 CHECK (friend_count >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

/* Devices and sessions are separate on purpose.
   A device is a long-lived thing the user recognises in "connected devices"
   (spec §25). A session is one login on it, and revoking a session must not
   erase the device's push token. */
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('web','ios','android')),
  name          text,                       -- "Chrome on macOS"
  user_agent    text,
  push_token    text,                       -- FCM/APNs, or a Web Push endpoint
  push_provider text CHECK (push_provider IN ('fcm','apns','webpush')),
  last_ip       inet,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX ON devices (user_id) WHERE revoked_at IS NULL;

/* Refresh tokens are stored as SHA-256 hashes, never in the clear: a database
   dump must not yield working sessions.

   `rotated_to` implements refresh-token rotation with reuse detection (spec
   §38). If a token that was already rotated is presented again, it was stolen —
   the whole family is revoked rather than just refusing that one request. */
CREATE TABLE sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id         uuid REFERENCES devices(id) ON DELETE SET NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  family_id         uuid NOT NULL,          -- shared by every rotation in a chain
  rotated_to        uuid REFERENCES sessions(id) ON DELETE SET NULL,
  expires_at        timestamptz NOT NULL,
  created_ip        inet,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_reason    text
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON sessions (family_id);
CREATE INDEX ON sessions (expires_at) WHERE revoked_at IS NULL;

/* One-time codes for email/phone verification and password reset. Hashed for
   the same reason as refresh tokens. */
CREATE TABLE verification_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('email_verify','phone_verify','password_reset')),
  destination  citext NOT NULL,             -- the email/phone it was sent to
  code_hash    text NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON verification_codes (user_id, purpose) WHERE consumed_at IS NULL;

-- ============================================================== SOCIAL ====

/* Friendship is stored once, not twice, with a CHECK forcing a canonical
   ordering. Two rows per friendship is the classic source of "A is B's friend
   but B is not A's". */
CREATE TABLE friendships (
  user_a      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE TABLE friend_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (from_user_id <> to_user_id)
);
-- Only one request may be outstanding in a direction at a time.
CREATE UNIQUE INDEX friend_requests_one_pending
  ON friend_requests (from_user_id, to_user_id) WHERE status = 'pending';

CREATE TABLE blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX ON blocks (blocked_id);

-- =============================================================== MEDIA ====

/* Bytes live in object storage; only metadata lives here (spec §32).
   `storage_key` is never sent to a client — media is served through signed,
   expiring URLs (spec §42). */
CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key  text NOT NULL UNIQUE,
  mime_type    text NOT NULL,
  byte_size    bigint NOT NULL CHECK (byte_size > 0),
  width        int,
  height       int,
  duration_ms  int,
  checksum     text,
  status       text NOT NULL DEFAULT 'uploading'
                 CHECK (status IN ('uploading','processing','ready','failed','removed')),
  moderation   text NOT NULL DEFAULT 'pending'
                 CHECK (moderation IN ('pending','approved','flagged','rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX ON media (owner_id, created_at DESC);
CREATE INDEX ON media (status) WHERE status IN ('uploading','processing');

/* Transcoded renditions — thumbnail, 480p, 720p (spec §33). */
CREATE TABLE media_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id    uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('thumbnail','preview','sd','hd','audio')),
  storage_key text NOT NULL UNIQUE,
  mime_type   text NOT NULL,
  byte_size   bigint,
  width       int,
  height      int,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, kind)
);

ALTER TABLE profiles ADD CONSTRAINT profiles_avatar_fk
  FOREIGN KEY (avatar_media_id) REFERENCES media(id) ON DELETE SET NULL;

-- =============================================================== SNAPS ====

CREATE TABLE snaps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id     uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('photo','video')),
  -- How long after opening the snap disappears. Server-controlled (spec §10).
  duration_sec int NOT NULL DEFAULT 5 CHECK (duration_sec BETWEEN 1 AND 60),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

/* Per-recipient state, so one snap sent to five people has five independent
   lifecycles. Expiry is computed by the server from opened_at, never trusted
   from a client. */
CREATE TABLE snap_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snap_id       uuid NOT NULL REFERENCES snaps(id) ON DELETE CASCADE,
  recipient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('sending','sent','delivered','opened','expired','failed')),
  delivered_at  timestamptz,
  opened_at     timestamptz,
  expires_at    timestamptz,
  replay_count  int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snap_id, recipient_id)
);
CREATE INDEX ON snap_recipients (recipient_id, status);
-- Drives the cleanup worker.
CREATE INDEX ON snap_recipients (expires_at) WHERE status = 'opened';

-- ================================================================ CHAT ====

CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('direct','group')),
  title        text,                        -- groups only
  avatar_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Disappearing messages, per conversation (spec §11). NULL = keep forever.
  disappear_after_sec int CHECK (disappear_after_sec > 0),
  last_message_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX ON conversations (last_message_at DESC NULLS LAST);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  muted_until     timestamptz,
  -- Read state lives here rather than per-message-per-user: one row updated on
  -- read beats N rows inserted.
  last_read_at    timestamptz,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX ON conversation_members (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  type            text NOT NULL
                    CHECK (type IN ('text','image','video','voice','gif','sticker','snap','system')),
  body            text,
  media_id        uuid REFERENCES media(id) ON DELETE SET NULL,
  snap_id         uuid REFERENCES snaps(id) ON DELETE SET NULL,
  reply_to_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- Client-generated, so an optimistic send can be reconciled and a retry after
  -- a dropped connection cannot duplicate the message (spec §40).
  client_nonce    text,
  delivered_at    timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz
);
CREATE INDEX ON messages (conversation_id, created_at DESC);
CREATE INDEX ON messages (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX messages_nonce ON messages (sender_id, client_nonce)
  WHERE client_nonce IS NOT NULL;

CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)         -- one reaction each, replaceable
);

-- ============================================================= STORIES ====

CREATE TABLE stories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id    uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  caption     text,
  privacy     text NOT NULL DEFAULT 'friends'
                CHECK (privacy IN ('everyone','friends','custom')),
  expires_at  timestamptz NOT NULL,
  view_count  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX ON stories (author_id, created_at DESC);
CREATE INDEX ON stories (expires_at) WHERE deleted_at IS NULL;

-- Named allow-list for privacy = 'custom'.
CREATE TABLE story_audience (
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, user_id)
);

CREATE TABLE story_views (
  story_id  uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE TABLE story_reactions (
  story_id   uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);

/* A story reply is a direct message, not a separate inbox — that is how these
   products actually behave, and it keeps one conversation per pair. */
CREATE TABLE story_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id   uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================== CALLS ====

CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  initiator_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('voice','video')),
  status          text NOT NULL DEFAULT 'ringing'
                    CHECK (status IN ('ringing','active','ended','missed','rejected','failed')),
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE call_participants (
  call_id   uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz,
  left_at   timestamptz,
  PRIMARY KEY (call_id, user_id)
);

-- ======================================================= MISC / SAFETY ====

CREATE TABLE memories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'snap' CHECK (kind IN ('snap','story','import')),
  favourite  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (user_id, media_id)
);
CREATE INDEX ON memories (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  data       jsonb NOT NULL DEFAULT '{}',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE notification_settings (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  messages       boolean NOT NULL DEFAULT true,
  snaps          boolean NOT NULL DEFAULT true,
  friend_requests boolean NOT NULL DEFAULT true,
  stories        boolean NOT NULL DEFAULT true,
  calls          boolean NOT NULL DEFAULT true
);

/* Privacy defaults are conservative (spec §25): friends-only, presence off. */
CREATE TABLE privacy_settings (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  who_can_contact   text NOT NULL DEFAULT 'friends'
                      CHECK (who_can_contact IN ('everyone','friends')),
  who_can_view_story text NOT NULL DEFAULT 'friends'
                      CHECK (who_can_view_story IN ('everyone','friends','custom')),
  show_activity     boolean NOT NULL DEFAULT false,
  discoverable_by_phone boolean NOT NULL DEFAULT true,
  discoverable_by_username boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  target_type    text NOT NULL
                   CHECK (target_type IN ('user','message','snap','story','media','group')),
  target_id      uuid NOT NULL,
  reason         text NOT NULL CHECK (reason IN
                   ('spam','harassment','bullying','nudity','violence',
                    'illegal','impersonation','copyright','other')),
  detail         text,
  status         text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','reviewing','actioned','dismissed','escalated')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX ON reports (status, created_at DESC);
CREATE INDEX ON reports (target_type, target_id);

CREATE TABLE moderation_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid REFERENCES reports(id) ON DELETE SET NULL,
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action IN
                ('warn','remove_content','suspend','ban','dismiss','escalate')),
  target_type text NOT NULL,
  target_id   uuid NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* Append-only. Being able to edit the audit trail defeats the point of it. */
CREATE TABLE admin_audit_logs (
  id         bigserial PRIMARY KEY,
  admin_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_audit_logs (created_at DESC);

CREATE OR REPLACE FUNCTION audit_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'admin_audit_logs is append-only'; END $$;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();

-- ============================================================ TRIGGERS ====

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

/* Keeps profiles.friend_count honest without a COUNT(*) on every profile read. */
CREATE OR REPLACE FUNCTION sync_friend_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta int;
BEGIN
  delta := CASE TG_OP WHEN 'INSERT' THEN 1 ELSE -1 END;
  UPDATE profiles SET friend_count = GREATEST(0, friend_count + delta)
   WHERE user_id IN (COALESCE(NEW.user_a, OLD.user_a), COALESCE(NEW.user_b, OLD.user_b));
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_friend_count AFTER INSERT OR DELETE ON friendships
  FOR EACH ROW EXECUTE FUNCTION sync_friend_count();

/* Helper used across the app: are these two users friends? Canonical ordering
   is applied here so no caller has to remember it. */
CREATE OR REPLACE FUNCTION are_friends(a uuid, b uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM friendships
                  WHERE user_a = LEAST(a, b) AND user_b = GREATEST(a, b))
$$;

/* Blocking is symmetric for visibility: if either has blocked the other, they
   cannot interact at all (spec §27). Enforced in the backend, not just UI. */
CREATE OR REPLACE FUNCTION is_blocked_between(a uuid, b uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM blocks
                  WHERE (blocker_id = a AND blocked_id = b)
                     OR (blocker_id = b AND blocked_id = a))
$$;
