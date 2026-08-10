-- AlterTable: recipe_versions bổ sung các cột phục vụ versioning
ALTER TABLE "recipe_versions" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by" INTEGER,
ADD COLUMN     "archived_reason" TEXT,
ADD COLUMN     "is_archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parent_version_id" INTEGER;

-- AlterTable: recipes bổ sung cột rollback + publishedAt
ALTER TABLE "recipes" ADD COLUMN     "previous_published_version_id" INTEGER,
ADD COLUMN     "published_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "recipe_versions_recipe_id_is_archived_idx" ON "recipe_versions"("recipe_id", "is_archived");

-- CreateIndex
CREATE INDEX "recipes_published_version_id_idx" ON "recipes"("published_version_id");

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_previous_published_version_id_fkey" FOREIGN KEY ("previous_published_version_id") REFERENCES "recipe_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "recipe_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
