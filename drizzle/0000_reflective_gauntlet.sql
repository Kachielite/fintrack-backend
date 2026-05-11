CREATE TABLE "admin_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_at" timestamp DEFAULT now() NOT NULL,
	"data" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "ai_usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"model_used" text NOT NULL,
	"user_id" integer,
	"transaction_id" integer,
	"template_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_code" text NOT NULL,
	"country" text,
	"known_sender_emails" text[] DEFAULT '{}' NOT NULL,
	"logo_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "banks_short_code_unique" UNIQUE("short_code")
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"category" text NOT NULL,
	"limit_amount" real NOT NULL,
	"currency" text NOT NULL,
	"period_type" text DEFAULT 'monthly' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_suggested_by_ai" boolean DEFAULT false NOT NULL,
	"suppressed_suggestions_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"gmail_address" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"token_expires_at" timestamp NOT NULL,
	"gmail_label_id" text,
	"gmail_label_name" text DEFAULT 'Bank Transactions',
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp,
	"last_sync_message_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_currency" text NOT NULL,
	"target_currency" text NOT NULL,
	"rate" real NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"target_amount" real,
	"saved_amount" real DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"target_date" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_connection_id" integer NOT NULL,
	"gmail_message_id" text NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"transaction_id" integer
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"context_data" json,
	"is_read" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" text,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parser_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"bank_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"field" text NOT NULL,
	"pattern" text NOT NULL,
	"flags" text DEFAULT 'i' NOT NULL,
	"extract_group" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"confidence_score" real DEFAULT 0 NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT 'ai' NOT NULL,
	"audit_notes" text,
	"audit_passed_at" timestamp,
	"promoted_at" timestamp,
	"deprecated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parser_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"bank_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"description" text,
	"email_subject_pattern" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"confidence_score" real DEFAULT 0 NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_rules" (
	"template_id" integer NOT NULL,
	"rule_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"email_connection_id" integer,
	"bank_id" integer,
	"parser_template_id" integer,
	"gmail_message_id" text,
	"merchant" text NOT NULL,
	"category" text NOT NULL,
	"transaction_type" text NOT NULL,
	"amount" real NOT NULL,
	"currency" text NOT NULL,
	"ref_amount" real NOT NULL,
	"ref_currency" text NOT NULL,
	"exchange_rate_used" real,
	"transaction_date" timestamp NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"original_merchant" text,
	"original_category" text,
	"reference" text,
	"balance" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"ref_currency" text DEFAULT 'NGN' NOT NULL,
	"advisor_tone" text DEFAULT 'warm' NOT NULL,
	"goal_type" text,
	"income_range" text,
	"pay_frequency" text,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"refresh_token_hash" text,
	"plan_tier" text DEFAULT 'free' NOT NULL,
	"data_retention_months" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD CONSTRAINT "processed_emails_email_connection_id_email_connections_id_fk" FOREIGN KEY ("email_connection_id") REFERENCES "public"."email_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parser_rules" ADD CONSTRAINT "parser_rules_bank_id_banks_id_fk" FOREIGN KEY ("bank_id") REFERENCES "public"."banks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parser_templates" ADD CONSTRAINT "parser_templates_bank_id_banks_id_fk" FOREIGN KEY ("bank_id") REFERENCES "public"."banks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_rules" ADD CONSTRAINT "template_rules_template_id_parser_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."parser_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_rules" ADD CONSTRAINT "template_rules_rule_id_parser_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."parser_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_email_connection_id_email_connections_id_fk" FOREIGN KEY ("email_connection_id") REFERENCES "public"."email_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_id_banks_id_fk" FOREIGN KEY ("bank_id") REFERENCES "public"."banks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_pair_idx" ON "exchange_rates" USING btree ("base_currency","target_currency");