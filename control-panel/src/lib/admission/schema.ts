/** Additive authoritative metadata, included in the encrypted platform DB. */
export const ADMISSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admission_principals (
  id uuid PRIMARY KEY,
  active boolean NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admission_principals (id, active)
SELECT id, is_active FROM identity_users
ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS admission_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key text COLLATE "C" NOT NULL UNIQUE,
  label text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admission_ui_mappings (
  identity_id uuid PRIMARY KEY REFERENCES admission_principals(id) ON DELETE RESTRICT,
  ui_user_id uuid NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS admission_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_key text COLLATE "C" NOT NULL UNIQUE,
  owner_id uuid NOT NULL REFERENCES admission_principals(id) ON DELETE RESTRICT,
  deleted_at timestamptz
);
INSERT INTO admission_groups (group_key, label)
SELECT DISTINCT key, key FROM identity_users u,
  LATERAL jsonb_array_elements_text(u.groups) AS keys(key)
ON CONFLICT (group_key) DO NOTHING;
CREATE TABLE IF NOT EXISTS admission_policies (
  installation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL UNIQUE CHECK (app_id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  owner_id uuid NOT NULL REFERENCES admission_principals(id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'owner' CHECK (mode IN ('owner','all_users','groups','users')),
  user_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(user_ids) = 'array'),
  group_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(group_ids) = 'array'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('ready','pending','quarantined','retained','deleted')),
  public_access boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admission_clients (
  client_id text PRIMARY KEY REFERENCES identity_clients(client_id) ON DELETE CASCADE,
  installation_id uuid REFERENCES admission_policies(installation_id) ON DELETE RESTRICT,
  platform_access boolean NOT NULL DEFAULT false,
  CHECK ((installation_id IS NULL) = platform_access),
  CHECK (NOT platform_access OR client_id IN ('youeye-control','youeye-ui'))
);
INSERT INTO admission_clients (client_id, platform_access)
SELECT client_id, true FROM identity_clients WHERE client_id IN ('youeye-control','youeye-ui')
ON CONFLICT (client_id) DO NOTHING;
CREATE OR REPLACE FUNCTION admission_platform_client_added()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_id IN ('youeye-control','youeye-ui') THEN
    INSERT INTO admission_clients (client_id, platform_access)
      VALUES (NEW.client_id, true) ON CONFLICT (client_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admission_platform_client_added ON identity_clients;
CREATE TRIGGER admission_platform_client_added AFTER INSERT ON identity_clients
FOR EACH ROW EXECUTE FUNCTION admission_platform_client_added();
CREATE TABLE IF NOT EXISTS admission_routes (
  host text COLLATE "C" NOT NULL,
  path_prefix text NOT NULL DEFAULT '/',
  installation_id uuid NOT NULL REFERENCES admission_policies(installation_id) ON DELETE RESTRICT,
  PRIMARY KEY (host, path_prefix)
);
CREATE TABLE IF NOT EXISTS admission_machine_callbacks (
  installation_id uuid NOT NULL REFERENCES admission_policies(installation_id) ON DELETE RESTRICT,
  host text NOT NULL,
  path text NOT NULL,
  method text NOT NULL CHECK (method IN ('GET','POST')),
  PRIMARY KEY (installation_id, host, path, method)
);
CREATE TABLE IF NOT EXISTS admission_resources (
  installation_id uuid NOT NULL REFERENCES admission_policies(installation_id) ON DELETE RESTRICT,
  resource_id text NOT NULL,
  declaration jsonb NOT NULL,
  owner_id uuid NOT NULL REFERENCES admission_principals(id) ON DELETE RESTRICT,
  private_user_id uuid REFERENCES admission_principals(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('active','quarantined','retained','deleted')),
  PRIMARY KEY (installation_id, resource_id)
);
CREATE TABLE IF NOT EXISTS admission_user_data_contracts (
  installation_id uuid PRIMARY KEY REFERENCES admission_policies(installation_id) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION admission_user_data_contract_lock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('youeye-admission-lifecycle'));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admission_user_data_contract_lock ON admission_user_data_contracts;
CREATE TRIGGER admission_user_data_contract_lock BEFORE INSERT ON admission_user_data_contracts
FOR EACH ROW EXECUTE FUNCTION admission_user_data_contract_lock();
CREATE OR REPLACE FUNCTION admission_register_user_data(uid uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO admission_resources (installation_id, resource_id, declaration, owner_id, private_user_id, state)
  SELECT p.installation_id, 'user-data:' || a.id::text,
    jsonb_build_object('schemaVersion',1,'appId',p.app_id,'installationId',p.installation_id,
      'resourceId','user-data:' || a.id::text,'scope','per_user','enforcement','app_native',
      'ownerId',a.id,'identityUserId',a.id,'uiUserId',NULL,'shareId',NULL,'consumerIds','[]'::jsonb,
      'state',CASE WHEN a.deleted_at IS NOT NULL THEN 'quarantined'
        WHEN p.state = 'retained' THEN 'retained' ELSE 'active' END),
    a.id, a.id, CASE WHEN a.deleted_at IS NOT NULL THEN 'quarantined'
      WHEN p.state = 'retained' THEN 'retained' ELSE 'active' END
  FROM admission_user_data_contracts c JOIN admission_policies p USING (installation_id)
    CROSS JOIN admission_principals a
  WHERE a.id = uid AND p.state <> 'deleted'
  ON CONFLICT (installation_id, resource_id) DO NOTHING
$$;
CREATE OR REPLACE FUNCTION admission_user_data_contract_added()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE uid uuid;
BEGIN
  FOR uid IN SELECT id FROM admission_principals LOOP
    PERFORM admission_register_user_data(uid);
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admission_user_data_contract_added ON admission_user_data_contracts;
CREATE TRIGGER admission_user_data_contract_added AFTER INSERT ON admission_user_data_contracts
FOR EACH ROW EXECUTE FUNCTION admission_user_data_contract_added();
CREATE TABLE IF NOT EXISTS admission_outbox (
  installation_id uuid PRIMARY KEY REFERENCES admission_policies(installation_id) ON DELETE RESTRICT,
  revision bigint NOT NULL,
  acknowledged_revision bigint NOT NULL DEFAULT 0,
  lease_sequence bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admission_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES admission_policies(installation_id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES admission_principals(id) ON DELETE RESTRICT,
  action text NOT NULL,
  revision bigint NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admission_client_cutoffs (
  client_id text NOT NULL REFERENCES identity_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES admission_principals(id) ON DELETE RESTRICT,
  revoked_before timestamptz NOT NULL,
  PRIMARY KEY (client_id, user_id)
);
CREATE TABLE IF NOT EXISTS admission_logout_outbox (
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES admission_principals(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL,
  revision bigint NOT NULL,
  queued boolean NOT NULL DEFAULT false,
  PRIMARY KEY (client_id, user_id, session_id)
);
CREATE OR REPLACE FUNCTION admission_policy_identity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.installation_id <> OLD.installation_id OR NEW.app_id <> OLD.app_id
    OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Immutable installation or stale policy revision';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admission_policy_identity_guard ON admission_policies;
CREATE TRIGGER admission_policy_identity_guard BEFORE UPDATE ON admission_policies
FOR EACH ROW EXECUTE FUNCTION admission_policy_identity_guard();
CREATE OR REPLACE FUNCTION admission_owner_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity_appliance_claim WHERE owner_user_id = OLD.id)
    AND (TG_OP = 'DELETE' OR NOT NEW.is_active OR NOT NEW.is_admin) THEN
    RAISE EXCEPTION 'Appliance owner and management recovery access must remain active';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS admission_owner_guard ON identity_users;
CREATE TRIGGER admission_owner_guard BEFORE UPDATE OR DELETE ON identity_users
FOR EACH ROW EXECUTE FUNCTION admission_owner_guard();
-- Used only for invalidating issued grants in the same transaction. Request
-- decisions use the shared TypeScript evaluator with freshly loaded principals.
CREATE OR REPLACE FUNCTION admission_granted(p admission_policies, uid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p.schema_version = 1 AND p.state = 'ready'
    AND u.is_active AND a.active AND a.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM admission_resources r WHERE r.installation_id = p.installation_id
      AND r.private_user_id = uid AND r.state = 'quarantined') AND
    (p.owner_id = uid OR p.mode = 'all_users'
      OR (p.mode = 'users' AND p.user_ids ? uid::text)
      OR (p.mode = 'groups' AND EXISTS (
        SELECT 1 FROM admission_groups g WHERE g.deleted_at IS NULL
          AND p.group_ids ? g.id::text AND u.groups ? g.group_key
      ))), false)
  FROM identity_users u JOIN admission_principals a ON a.id = u.id WHERE u.id = uid
$$;
-- Grant issuance holds the identity/policy locks until its insert commits.
-- Membership/policy revocation can then see and invalidate that exact grant.
CREATE OR REPLACE FUNCTION admission_client_granted(cid text, uid uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE u identity_users; c admission_clients; p admission_policies;
BEGIN
  SELECT * INTO u FROM identity_users WHERE id = uid FOR SHARE;
  IF NOT FOUND OR NOT u.is_active THEN RETURN false; END IF;
  SELECT * INTO c FROM admission_clients WHERE client_id = cid FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.platform_access THEN RETURN true; END IF;
  SELECT * INTO p FROM admission_policies WHERE installation_id = c.installation_id FOR SHARE;
  IF NOT FOUND OR NOT COALESCE(admission_granted(p, uid), false) THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM admission_outbox WHERE installation_id = p.installation_id
    AND acknowledged_revision = p.revision);
END $$;
CREATE OR REPLACE FUNCTION admission_invalidate_grants(p admission_policies)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO admission_client_cutoffs (client_id, user_id, revoked_before)
  SELECT c.client_id, u.id, now() FROM admission_clients c CROSS JOIN admission_principals u
  WHERE c.installation_id = p.installation_id
    AND NOT COALESCE(admission_granted(p, u.id), false)
  ON CONFLICT (client_id, user_id) DO UPDATE SET revoked_before = EXCLUDED.revoked_before;
  UPDATE identity_refresh_tokens t SET revoked_at = COALESCE(t.revoked_at, now())
  FROM admission_clients c WHERE c.installation_id = p.installation_id
    AND t.client_id = c.client_id AND NOT COALESCE(admission_granted(p, t.user_id), false);
  DELETE FROM identity_auth_codes t USING admission_clients c
  WHERE c.installation_id = p.installation_id AND t.client_id = c.client_id
    AND NOT COALESCE(admission_granted(p, t.user_id), false);
  INSERT INTO admission_logout_outbox (client_id, user_id, session_id, revision)
  SELECT c.client_id, s.user_id, s.session_id, p.revision FROM admission_clients c
    JOIN identity_session_clients s USING (client_id)
  WHERE c.installation_id = p.installation_id AND NOT COALESCE(admission_granted(p, s.user_id), false)
  ON CONFLICT (client_id, user_id, session_id) DO UPDATE
    SET revision = EXCLUDED.revision, queued = false;
END $$;
CREATE OR REPLACE FUNCTION admission_policy_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO admission_outbox (installation_id, revision)
  VALUES (NEW.installation_id, NEW.revision)
  ON CONFLICT (installation_id) DO UPDATE SET revision = EXCLUDED.revision,
    updated_at = now(), last_error = NULL;
  PERFORM admission_invalidate_grants(NEW);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admission_policy_changed ON admission_policies;
CREATE TRIGGER admission_policy_changed AFTER INSERT OR UPDATE ON admission_policies
FOR EACH ROW EXECUTE FUNCTION admission_policy_changed();
CREATE OR REPLACE FUNCTION admission_client_bound()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p admission_policies;
BEGIN
  IF NEW.installation_id IS NOT NULL THEN
    SELECT * INTO p FROM admission_policies WHERE installation_id = NEW.installation_id;
    PERFORM admission_invalidate_grants(p);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admission_client_bound ON admission_clients;
CREATE TRIGGER admission_client_bound AFTER INSERT ON admission_clients
FOR EACH ROW EXECUTE FUNCTION admission_client_bound();
CREATE OR REPLACE FUNCTION admission_identity_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize namespace reservation with deletion: a concurrent contract or
  -- new identity must observe the other's committed namespace/tombstone.
  PERFORM pg_advisory_xact_lock(hashtext('youeye-admission-lifecycle'));
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM admission_policies WHERE owner_id = OLD.id AND state <> 'deleted')
      OR EXISTS (SELECT 1 FROM admission_resources
        WHERE (private_user_id = OLD.id OR owner_id = OLD.id) AND state IN ('active','retained')) THEN
      RAISE EXCEPTION 'Owned application or private data requires explicit disposition before deleting this user';
    END IF;
    UPDATE admission_principals SET active = false, deleted_at = now() WHERE id = OLD.id;
    UPDATE admission_policies SET revision = revision + 1, updated_at = now()
      WHERE state <> 'deleted' AND (owner_id = OLD.id OR mode = 'all_users'
        OR (mode = 'users' AND user_ids ? OLD.id::text)
        OR (mode = 'groups' AND EXISTS (SELECT 1 FROM admission_groups g
          WHERE group_ids ? g.id::text AND OLD.groups ? g.group_key)));
    RETURN OLD;
  END IF;
  INSERT INTO admission_principals (id, active) VALUES (NEW.id, NEW.is_active)
    ON CONFLICT (id) DO UPDATE SET active = EXCLUDED.active
      WHERE admission_principals.deleted_at IS NULL;
  IF EXISTS (SELECT 1 FROM admission_principals WHERE id = NEW.id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Deleted identity UUID cannot be recreated';
  END IF;
  PERFORM admission_register_user_data(NEW.id);
  INSERT INTO admission_groups (group_key, label)
    SELECT key, key FROM jsonb_array_elements_text(NEW.groups) AS keys(key)
    ON CONFLICT (group_key) DO NOTHING;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.groups IS DISTINCT FROM NEW.groups THEN
      UPDATE admission_policies SET revision = revision + 1, updated_at = now()
        WHERE state <> 'deleted' AND (
          (OLD.is_active IS DISTINCT FROM NEW.is_active AND
            (owner_id = NEW.id OR mode = 'all_users' OR (mode = 'users' AND user_ids ? NEW.id::text)
              OR (mode = 'groups' AND EXISTS (SELECT 1 FROM admission_groups g
                WHERE group_ids ? g.id::text AND (OLD.groups ? g.group_key OR NEW.groups ? g.group_key)))))
          OR (mode = 'groups' AND EXISTS (SELECT 1 FROM admission_groups g
            WHERE group_ids ? g.id::text AND (OLD.groups ? g.group_key) IS DISTINCT FROM (NEW.groups ? g.group_key)))
        );
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS admission_identity_changed ON identity_users;
CREATE TRIGGER admission_identity_changed AFTER INSERT OR UPDATE ON identity_users
FOR EACH ROW EXECUTE FUNCTION admission_identity_changed();
DROP TRIGGER IF EXISTS admission_identity_deleted ON identity_users;
CREATE TRIGGER admission_identity_deleted BEFORE DELETE ON identity_users
FOR EACH ROW EXECUTE FUNCTION admission_identity_changed();
`;
