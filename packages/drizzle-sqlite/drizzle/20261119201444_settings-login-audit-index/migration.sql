-- Xplain indexes accept columns only. Match the actor expression in Settings' latestLogin query.
CREATE INDEX `pf_audit_event_kind_actor_occurred_at_idx`
  ON `pf_audit_event` (`audit_kind`, json_extract(`audit_details`, '$.actorUserId'), `occurred_at`);
