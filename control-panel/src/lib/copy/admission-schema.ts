/** Native copy is the sole explicit installation rebind. Ordinary policy writes
 * keep the immutable-identity guard and monotonic revisions. Deferred foreign
 * keys permit one atomic rebind; they remain immediate for ordinary writers. */
export const ADMISSION_COPY_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS admission_copy_bindings (
 request_id text NOT NULL REFERENCES identity_copy_preparations(request_id) ON DELETE RESTRICT,
 app_id text NOT NULL,
 source_installation_id uuid NOT NULL,
 destination_installation_id uuid NOT NULL UNIQUE,
 completed_at timestamptz,
 PRIMARY KEY(request_id,app_id),
 CHECK(source_installation_id<>destination_installation_id)
);
DO $copy_constraints$
DECLARE item record;
BEGIN
 FOR item IN SELECT conrelid::regclass AS tab,conname FROM pg_constraint
   WHERE contype='f' AND confrelid='admission_policies'::regclass LOOP
  EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',item.tab,item.conname);
 END LOOP;
END $copy_constraints$;
CREATE OR REPLACE FUNCTION admission_policy_identity_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.app_id<>OLD.app_id OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Immutable installation or stale policy revision';
 END IF;
 IF NEW.installation_id<>OLD.installation_id AND NOT (
  NEW.state='pending' AND EXISTS(SELECT 1 FROM admission_copy_bindings b
   WHERE b.request_id=current_setting('youeye.independent_copy_request',true)
    AND b.app_id=OLD.app_id AND b.source_installation_id=OLD.installation_id
    AND b.destination_installation_id=NEW.installation_id AND b.completed_at IS NULL)
 ) THEN RAISE EXCEPTION 'Immutable installation or stale policy revision'; END IF;
 RETURN NEW;
END $$;
`;
