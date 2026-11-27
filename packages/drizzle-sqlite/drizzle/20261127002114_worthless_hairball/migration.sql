CREATE TABLE `pf_mcp_oauth_record` (
	`id` text(41) PRIMARY KEY,
	`mcp_partition` text(2048) NOT NULL,
	`mcp_record_key` text(64) NOT NULL,
	`mcp_revision` text(36) NOT NULL,
	`key_value` text NOT NULL,
	`key_expiry` real,
	`created_at` real DEFAULT (julianday('now')) NOT NULL,
	`updated_at` real DEFAULT (julianday('now')) NOT NULL,
	`created_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`updated_by` text(256) DEFAULT 'SYSTEM' NOT NULL,
	`_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pf_mcp_oauth_record_expiryidx_idx` ON `pf_mcp_oauth_record` (`key_expiry`) WHERE _deleted = 0;--> statement-breakpoint
CREATE UNIQUE INDEX `pf_mcp_oauth_record_partitionkeyidx_idx` ON `pf_mcp_oauth_record` (`mcp_partition`,`mcp_record_key`) WHERE _deleted = 0;--> statement-breakpoint
CREATE INDEX `pf_mcp_oauth_record_updated_at_id_idx` ON `pf_mcp_oauth_record` (`updated_at`,`id`);