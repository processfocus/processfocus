ALTER TABLE `pf_secret_generation` ADD `parent_secret_generation` text(41) REFERENCES pf_secret_generation(id);
--> statement-breakpoint
-- Migration-private closure index: Turso Local cannot prepare recursive CTEs.
-- Copy immutable ancestor identities at insertion, but check their live validity
-- below. Checking only the parent misses ancestors invalidated after its issuance.
CREATE TABLE pf_secret_generation_ancestor (
  generation_id text(41) NOT NULL REFERENCES pf_secret_generation(id),
  ancestor_id text(41) NOT NULL REFERENCES pf_secret_generation(id),
  PRIMARY KEY (generation_id, ancestor_id)
);
--> statement-breakpoint
-- All generations predating the parent column are roots.
INSERT INTO pf_secret_generation_ancestor SELECT id, id FROM pf_secret_generation;
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_ancestor_no_update
BEFORE UPDATE ON pf_secret_generation_ancestor
BEGIN
  SELECT RAISE(ABORT, 'Secret Generation ancestry is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_ancestor_no_delete
BEFORE DELETE ON pf_secret_generation_ancestor
BEGIN
  SELECT RAISE(ABORT, 'Secret Generation ancestry must be retained');
END;
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_ancestor_insert
AFTER INSERT ON pf_secret_generation
BEGIN
  INSERT INTO pf_secret_generation_ancestor (generation_id, ancestor_id)
    SELECT NEW.id, ancestor_id FROM pf_secret_generation_ancestor
    WHERE generation_id = NEW.parent_secret_generation;
  INSERT INTO pf_secret_generation_ancestor (generation_id, ancestor_id)
    VALUES (NEW.id, NEW.id);
END;
--> statement-breakpoint
-- Lineage is append-only, including against INSERT OR REPLACE and ID reuse.
CREATE TRIGGER pf_secret_generation_lineage_immutable
BEFORE UPDATE ON pf_secret_generation
WHEN NEW.id IS NOT OLD.id
  OR NEW.delegation_id IS NOT OLD.delegation_id
  OR NEW.parent_secret_generation IS NOT OLD.parent_secret_generation
BEGIN
  SELECT RAISE(ABORT, 'Secret Generation lineage is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_lineage_no_delete
BEFORE DELETE ON pf_secret_generation
BEGIN
  SELECT RAISE(ABORT, 'Secret Generation history must be retained');
END;
--> statement-breakpoint
CREATE TRIGGER pf_secret_generation_lineage_insert
BEFORE INSERT ON pf_secret_generation
BEGIN
  SELECT RAISE(ABORT, 'Secret Generation identity already exists')
  WHERE EXISTS (SELECT 1 FROM pf_secret_generation WHERE id = NEW.id);

  SELECT RAISE(ABORT, 'Invalid Secret Generation lineage')
  WHERE NEW.parent_secret_generation IS NOT NULL AND (
    NEW.parent_secret_generation = NEW.id
    OR NOT EXISTS (
      SELECT 1 FROM pf_secret_generation WHERE id = NEW.parent_secret_generation
    )
    OR NEW.secret_expires_at <= NEW.secret_issued_at
    OR EXISTS (
      SELECT 1 FROM pf_secret_generation_ancestor lineage
      JOIN pf_secret_generation a ON a.id = lineage.ancestor_id
      LEFT JOIN pf_delegation d ON d.id = a.delegation_id
      LEFT JOIN pf_provider_user p ON p.id = d.owner_provider_user
      LEFT JOIN pf_user u ON u.id = p.user_id
      WHERE lineage.generation_id = NEW.parent_secret_generation AND (
        a.id = NEW.id OR a.delegation_id = NEW.delegation_id
        OR a._deleted != 0 OR a.secret_revoked_at IS NOT NULL
        OR a.secret_issued_at > NEW.secret_issued_at
        OR a.secret_expires_at <= NEW.secret_issued_at
        OR a.secret_expires_at < NEW.secret_expires_at
        OR d.id IS NULL OR d._deleted != 0 OR d.secret_revoked_at IS NOT NULL
        OR p.id IS NULL OR p._deleted != 0 OR u.id IS NULL OR u._deleted != 0
        OR EXISTS (
          SELECT 1 FROM pf_delegation_history h
          WHERE h.secret_generation_id = a.id AND h.delegation_event = 'replaced'
        )
      )
    )
  );
END;
