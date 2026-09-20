ALTER TABLE "pf_delegation_history" ADD COLUMN "actor_delegation" varchar(41);--> statement-breakpoint
ALTER TABLE "pf_delegation_history" ADD COLUMN "actor_secret_generation" varchar(41);--> statement-breakpoint
ALTER TABLE "pf_delegation_history" ADD CONSTRAINT "pf_delegation_history_actor_delegation_pf_delegation_id_fkey" FOREIGN KEY ("actor_delegation") REFERENCES "pf_delegation"("id");--> statement-breakpoint
ALTER TABLE "pf_delegation_history" ADD CONSTRAINT "pf_delegation_history_JMUtqxSKg9mN_fkey" FOREIGN KEY ("actor_secret_generation") REFERENCES "pf_secret_generation"("id");