-- Remove recipe step duration. Existing duration values are intentionally discarded.
ALTER TABLE "recipe_steps" DROP COLUMN "duration_seconds";
