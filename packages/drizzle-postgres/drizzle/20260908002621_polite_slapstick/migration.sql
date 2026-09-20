ALTER TABLE "pf_secret_generation" ADD COLUMN "parent_secret_generation" varchar(41);--> statement-breakpoint
ALTER TABLE "pf_secret_generation" ADD CONSTRAINT "pf_secret_generation_OttE6bv53SLw_fkey" FOREIGN KEY ("parent_secret_generation") REFERENCES "pf_secret_generation"("id");
--> statement-breakpoint
CREATE FUNCTION pf_secret_generation_check_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ancestor_ids varchar(41)[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Secret Generation history must be retained';
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
      OR NEW.parent_secret_generation IS DISTINCT FROM OLD.parent_secret_generation THEN
      RAISE EXCEPTION 'Secret Generation lineage is immutable';
    END IF;
  ELSIF NEW.parent_secret_generation IS NOT NULL THEN
    -- Lineage is immutable. Lock its base rows (not the recursive CTE), then
    -- each mutable validity dependency in order. Separate statements ensure
    -- validation sees commits we waited for under READ COMMITTED.
    WITH RECURSIVE ancestry AS (
      SELECT id, parent_secret_generation FROM pf_secret_generation WHERE id = NEW.parent_secret_generation
      UNION
      SELECT parent.id, parent.parent_secret_generation FROM pf_secret_generation parent
      JOIN ancestry child ON parent.id = child.parent_secret_generation
    ), locked AS (
      SELECT g.id FROM pf_secret_generation g JOIN ancestry a ON a.id = g.id
      ORDER BY g.id FOR UPDATE OF g
    )
    SELECT array_agg(id) INTO ancestor_ids FROM locked;

    PERFORM d.id FROM pf_delegation d
    WHERE d.id IN (SELECT delegation_id FROM pf_secret_generation WHERE id = ANY(ancestor_ids))
    ORDER BY d.id FOR SHARE OF d;
    PERFORM p.id FROM pf_provider_user p
    WHERE p.id IN (
      SELECT owner_provider_user FROM pf_delegation
      WHERE id IN (SELECT delegation_id FROM pf_secret_generation WHERE id = ANY(ancestor_ids))
    ) ORDER BY p.id FOR SHARE OF p;
    PERFORM u.id FROM pf_user u
    WHERE u.id IN (
      SELECT user_id FROM pf_provider_user WHERE id IN (
        SELECT owner_provider_user FROM pf_delegation
        WHERE id IN (SELECT delegation_id FROM pf_secret_generation WHERE id = ANY(ancestor_ids))
      )
    ) ORDER BY u.id FOR SHARE OF u;

    IF NEW.parent_secret_generation = NEW.id
      OR NOT EXISTS (SELECT 1 FROM pf_secret_generation WHERE id = NEW.parent_secret_generation)
      OR NEW.secret_expires_at <= NEW.secret_issued_at
      OR EXISTS (
        WITH RECURSIVE ancestry AS (
          SELECT * FROM pf_secret_generation WHERE id = NEW.parent_secret_generation
          UNION
          SELECT parent.* FROM pf_secret_generation parent
          JOIN ancestry child ON parent.id = child.parent_secret_generation
        )
        SELECT 1 FROM ancestry a
        LEFT JOIN pf_delegation d ON d.id = a.delegation_id
        LEFT JOIN pf_provider_user p ON p.id = d.owner_provider_user
        LEFT JOIN pf_user u ON u.id = p.user_id
        WHERE a.id = NEW.id OR a.delegation_id = NEW.delegation_id
          OR a._deleted OR a.secret_revoked_at IS NOT NULL
          OR a.secret_issued_at > NEW.secret_issued_at
          OR a.secret_expires_at <= NEW.secret_issued_at
          OR a.secret_expires_at < NEW.secret_expires_at
          OR d.id IS NULL OR d._deleted OR d.secret_revoked_at IS NOT NULL
          OR p.id IS NULL OR p._deleted OR u.id IS NULL OR u._deleted
          OR EXISTS (
            SELECT 1 FROM pf_delegation_history h
            WHERE h.secret_generation_id = a.id AND h.delegation_event = 'replaced'
          )
      ) THEN
      RAISE EXCEPTION 'Invalid Secret Generation lineage';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_lineage
BEFORE INSERT OR UPDATE OR DELETE ON pf_secret_generation
FOR EACH ROW EXECUTE FUNCTION pf_secret_generation_check_lineage();
--> statement-breakpoint
CREATE FUNCTION pf_delegation_history_lock_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A replacement is also an invalidation, even without updating the generation.
  IF NEW.delegation_event = 'replaced' THEN
    PERFORM id FROM pf_secret_generation WHERE id = NEW.secret_generation_id FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pf_delegation_history_lineage
BEFORE INSERT OR UPDATE ON pf_delegation_history
FOR EACH ROW EXECUTE FUNCTION pf_delegation_history_lock_lineage();
