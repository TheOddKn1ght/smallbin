CREATE TABLE `bins` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bins_expiry_idx` ON `bins` (`expires_at`);