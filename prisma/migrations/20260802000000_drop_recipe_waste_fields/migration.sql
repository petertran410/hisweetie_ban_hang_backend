-- Loại bỏ hoàn toàn "hao hụt" trong recipes.
ALTER TABLE "recipe_ingredients" DROP COLUMN "waste_percent";
ALTER TABLE "recipe_versions" DROP COLUMN "waste_cost";
ALTER TABLE "recipe_cost_histories" DROP COLUMN "waste_cost";
