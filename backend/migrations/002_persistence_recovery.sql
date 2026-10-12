-- Add internal dispatch/recovery fields without changing public DTOs.
ALTER TABLE jobs ADD COLUMN operation_payload JSONB;
ALTER TABLE jobs ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'none'
  CHECK (dispatch_state IN ('none', 'pending', 'running', 'done', 'reconcile_required'));
ALTER TABLE missions ADD COLUMN principal TEXT;
ALTER TABLE events ADD COLUMN request_id TEXT;
ALTER TABLE events ADD COLUMN resource_ref JSONB;
ALTER TABLE events ADD COLUMN boot_epoch TEXT;
ALTER TABLE events ADD COLUMN generation BIGINT;
CREATE INDEX events_created_at_idx ON events(created_at, id);
CREATE INDEX jobs_dispatch_state_idx ON jobs(dispatch_state, status);

-- A ready revision may be marked failed when its required files are missing,
-- but its identity and content cannot silently change in place.
CREATE FUNCTION prevent_ready_map_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' AND
     (NEW.map_id IS DISTINCT FROM OLD.map_id OR
      NEW.revision IS DISTINCT FROM OLD.revision OR
      NEW.name IS DISTINCT FROM OLD.name OR
      (NEW.status = 'ready' AND NEW.metadata IS DISTINCT FROM OLD.metadata) OR
      NEW.status = 'creating') THEN
    RAISE EXCEPTION 'READY_MAP_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER map_revision_ready_immutable
  BEFORE UPDATE ON map_revisions FOR EACH ROW
  EXECUTE FUNCTION prevent_ready_map_rewrite();

CREATE FUNCTION prevent_ready_asset_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' AND
     (NEW.id IS DISTINCT FROM OLD.id OR
      NEW.map_id IS DISTINCT FROM OLD.map_id OR
      NEW.revision IS DISTINCT FROM OLD.revision OR
      NEW.asset_kind IS DISTINCT FROM OLD.asset_kind OR
      NEW.storage_key IS DISTINCT FROM OLD.storage_key OR
      NEW.sha256 IS DISTINCT FROM OLD.sha256 OR
      NEW.byte_count IS DISTINCT FROM OLD.byte_count OR
      NEW.status = 'staging') THEN
    RAISE EXCEPTION 'READY_ASSET_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER map_asset_ready_immutable
  BEFORE UPDATE ON map_assets FOR EACH ROW
  EXECUTE FUNCTION prevent_ready_asset_rewrite();
