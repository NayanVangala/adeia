CREATE TABLE `site_visits` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`visitor_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_visits_day_visitor_uq` ON `site_visits` (`day`,`visitor_hash`);--> statement-breakpoint
CREATE INDEX `site_visits_day_idx` ON `site_visits` (`day`);