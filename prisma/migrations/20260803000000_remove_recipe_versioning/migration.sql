-- Loại bỏ hoàn toàn RecipeVersion: gộp version hiện hành vào Recipe.
-- Nội dung (ingredients/steps/images) và chi phí chuyển khóa trực tiếp về recipe.
--
-- Version được giữ lại, theo thứ tự ưu tiên:
--   1. published_version_id  (bản đang hiển thị công khai — ưu tiên cao nhất
--      để trang /cong-thuc không đổi nội dung sau migration)
--   2. current_version_id    (bản nháp đang sửa, dùng khi chưa từng publish)
--   3. version_number lớn nhất (phòng khi cả hai đều NULL)
-- Dữ liệu con thuộc các version còn lại sẽ bị xóa.

-- ─── 1. Thêm cột nội dung/chi phí vào recipes ──────────────────────────────
ALTER TABLE "recipes"
  ADD COLUMN "published_by"         INTEGER,
  ADD COLUMN "change_note"          TEXT,
  ADD COLUMN "currency_code"        CHAR(3)        NOT NULL DEFAULT 'VND',
  ADD COLUMN "cost_status"          TEXT           NOT NULL DEFAULT 'FRESH',
  ADD COLUMN "material_cost"        DECIMAL(18, 6),
  ADD COLUMN "semi_finished_cost"   DECIMAL(18, 6),
  ADD COLUMN "custom_cost"          DECIMAL(18, 6),
  ADD COLUMN "total_cost"           DECIMAL(18, 6),
  ADD COLUMN "cost_per_output_unit" DECIMAL(18, 6);

-- ─── 2. Backfill từ version hiện hành ──────────────────────────────────────
-- Ưu tiên published_version_id; fallback current_version_id; cuối cùng là
-- version có version_number lớn nhất (phòng trường hợp cả hai đều NULL).
UPDATE "recipes" r
SET
  "published_by"         = v."published_by",
  "change_note"          = v."change_note",
  "currency_code"        = v."currency_code",
  "cost_status"          = v."cost_status",
  "material_cost"        = v."material_cost",
  "semi_finished_cost"   = v."semi_finished_cost",
  "custom_cost"          = v."custom_cost",
  "total_cost"           = v."total_cost",
  "cost_per_output_unit" = v."cost_per_output_unit",
  "description"          = COALESCE(v."description", r."description")
FROM "recipe_versions" v
WHERE v."id" = COALESCE(
  r."published_version_id",
  r."current_version_id",
  (SELECT x."id" FROM "recipe_versions" x
    WHERE x."recipe_id" = r."id"
    ORDER BY x."version_number" DESC
    LIMIT 1)
);

-- ─── 3. Bảng con: thêm recipe_id và backfill ───────────────────────────────
ALTER TABLE "recipe_ingredients" ADD COLUMN "recipe_id" INTEGER;
ALTER TABLE "recipe_steps"       ADD COLUMN "recipe_id" INTEGER;
ALTER TABLE "recipe_images"      ADD COLUMN "recipe_id" INTEGER;

-- Chỉ backfill dòng thuộc version được giữ lại; dòng còn lại để NULL rồi xóa.
UPDATE "recipe_ingredients" c
SET "recipe_id" = r."id"
FROM "recipe_versions" v
JOIN "recipes" r ON r."id" = v."recipe_id"
WHERE c."recipe_version_id" = v."id"
  AND v."id" = COALESCE(
    r."published_version_id",
    r."current_version_id",
    (SELECT x."id" FROM "recipe_versions" x
      WHERE x."recipe_id" = r."id"
      ORDER BY x."version_number" DESC
      LIMIT 1)
  );

UPDATE "recipe_steps" c
SET "recipe_id" = r."id"
FROM "recipe_versions" v
JOIN "recipes" r ON r."id" = v."recipe_id"
WHERE c."recipe_version_id" = v."id"
  AND v."id" = COALESCE(
    r."published_version_id",
    r."current_version_id",
    (SELECT x."id" FROM "recipe_versions" x
      WHERE x."recipe_id" = r."id"
      ORDER BY x."version_number" DESC
      LIMIT 1)
  );

UPDATE "recipe_images" c
SET "recipe_id" = v."recipe_id"
FROM "recipe_versions" v
WHERE c."recipe_version_id" = v."id";

-- Khử trùng lặp ảnh: cùng recipe + cùng file_url thì chỉ giữ bản ghi cũ nhất.
DELETE FROM "recipe_images" a
USING "recipe_images" b
WHERE a."recipe_id" = b."recipe_id"
  AND a."file_url" = b."file_url"
  AND a."id" > b."id";

-- ─── 4. Xóa dòng con mồ côi (thuộc version không được giữ) ─────────────────
DELETE FROM "recipe_ingredients" WHERE "recipe_id" IS NULL;
DELETE FROM "recipe_steps"       WHERE "recipe_id" IS NULL;
DELETE FROM "recipe_images"      WHERE "recipe_id" IS NULL;

-- ─── 5. Ràng buộc bảng con ─────────────────────────────────────────────────
ALTER TABLE "recipe_ingredients" ALTER COLUMN "recipe_id" SET NOT NULL;
ALTER TABLE "recipe_steps"       ALTER COLUMN "recipe_id" SET NOT NULL;
ALTER TABLE "recipe_images"      ALTER COLUMN "recipe_id" SET NOT NULL;

ALTER TABLE "recipe_ingredients"
  DROP CONSTRAINT "recipe_ingredients_recipe_version_id_fkey",
  DROP CONSTRAINT "recipe_ingredients_recipe_reference_version_id_fkey",
  DROP COLUMN "recipe_version_id",
  DROP COLUMN "recipe_reference_version_id",
  DROP COLUMN "reference_mode",
  ADD CONSTRAINT "recipe_ingredients_recipe_id_fkey"
    FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recipe_steps"
  DROP CONSTRAINT "recipe_steps_recipe_version_id_fkey",
  DROP COLUMN "recipe_version_id",
  ADD CONSTRAINT "recipe_steps_recipe_id_fkey"
    FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recipe_images"
  DROP CONSTRAINT "recipe_images_recipe_version_id_fkey",
  DROP COLUMN "recipe_version_id",
  ADD CONSTRAINT "recipe_images_recipe_id_fkey"
    FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "recipe_ingredients_recipe_version_id_sort_order_idx";
DROP INDEX IF EXISTS "recipe_steps_recipe_version_id_sort_order_idx";
DROP INDEX IF EXISTS "recipe_images_recipe_version_id_sort_order_idx";

CREATE INDEX "recipe_ingredients_recipe_id_sort_order_idx" ON "recipe_ingredients"("recipe_id", "sort_order");
CREATE INDEX "recipe_steps_recipe_id_sort_order_idx"       ON "recipe_steps"("recipe_id", "sort_order");
CREATE INDEX "recipe_images_recipe_id_sort_order_idx"      ON "recipe_images"("recipe_id", "sort_order");

-- ─── 6. Dependencies: bỏ tham chiếu version ────────────────────────────────
ALTER TABLE "recipe_dependencies"
  DROP CONSTRAINT "recipe_dependencies_source_recipe_version_id_fkey",
  DROP COLUMN "source_recipe_version_id";

DROP INDEX IF EXISTS "recipe_dependencies_source_recipe_version_id_idx";

-- ─── 7. Bỏ lịch sử tính giá ────────────────────────────────────────────────
DROP TABLE "recipe_cost_histories";

-- ─── 8. Bỏ cột version trên recipes và xóa bảng version ────────────────────
ALTER TABLE "recipes"
  DROP CONSTRAINT "recipes_previous_published_version_id_fkey",
  DROP COLUMN "current_version_id",
  DROP COLUMN "published_version_id",
  DROP COLUMN "previous_published_version_id";

DROP INDEX IF EXISTS "recipes_published_version_id_idx";

DROP TABLE "recipe_versions";

ALTER TABLE "recipes"
  ADD CONSTRAINT "recipes_published_by_fkey"
    FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
