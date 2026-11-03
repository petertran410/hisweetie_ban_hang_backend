/**
 * Dựng các dòng product_images từ danh sách URL, đánh dấu đúng 1 ảnh chính.
 *
 * Ảnh chính = URL đầu tiên trong `primaryCandidates` có mặt trong danh sách
 * (thường là: ảnh client chọn, rồi ảnh chính cũ); không khớp thì lấy ảnh đầu.
 * URL bị lặp thì chỉ lần xuất hiện đầu tiên được đánh dấu.
 */
export function buildProductImageRows(
  productId: number,
  imageUrls: string[],
  ...primaryCandidates: (string | null | undefined)[]
) {
  const primaryUrl =
    primaryCandidates.find((url) => !!url && imageUrls.includes(url)) ??
    imageUrls[0];
  const primaryIndex = imageUrls.indexOf(primaryUrl);

  return imageUrls.map((url, index) => ({
    productId,
    image: url,
    isPrimary: index === primaryIndex,
  }));
}
