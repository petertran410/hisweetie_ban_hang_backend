import { BadRequestException } from '@nestjs/common';
import { join } from 'path';
import {
  ALLOWED_UPLOAD_SUBFOLDERS,
  assertAllowedExtension,
  resolveUploadDir,
  safeImageExtension,
  safeStoredExtension,
  uploadRoot,
} from './upload-paths.util';

describe('upload-paths.util', () => {
  describe('resolveUploadDir', () => {
    it('chấp nhận mọi thư mục web/mobile/backend đang dùng', () => {
      const used = [
        '',
        'products',
        'products/cong-bo',
        'product-quality',
        'vehicle-shipments',
        'bao-gia',
        'recipes',
        'smax-chat',
        'bao-don',
        'bao-don/chi-phi',
        'dong-hang',
        'loading',
        'ky-gui',
      ];
      for (const sub of used) {
        expect(ALLOWED_UPLOAD_SUBFOLDERS.has(sub)).toBe(true);
        expect(resolveUploadDir(sub).dir).toBe(join(uploadRoot(), sub));
      }
    });

    it('không có subfolder → gốc uploads/', () => {
      expect(resolveUploadDir(undefined)).toEqual({
        dir: uploadRoot(),
        subfolder: '',
      });
      expect(resolveUploadDir(null).dir).toBe(uploadRoot());
    });

    it('bỏ dấu / thừa ở đầu và cuối', () => {
      expect(resolveUploadDir('/bao-don/chi-phi/').subfolder).toBe(
        'bao-don/chi-phi',
      );
    });

    it.each([
      '../dist',
      '..',
      'bao-don/../../etc',
      'bao-don/..',
      '/etc',
      'contracts',
      'products/cong-bo/../../..',
      'unknown',
    ])('từ chối thư mục %p', (sub) => {
      expect(() => resolveUploadDir(sub)).toThrow(BadRequestException);
    });
  });

  describe('đuôi file', () => {
    it.each([
      'x.html',
      'x.HTM',
      'x.svg',
      'a.b.Svg',
      'x.xml',
      'x.js',
      'x.mjs',
      'x.xhtml',
    ])('chặn %p', (name) => {
      expect(() => assertAllowedExtension(name)).toThrow(BadRequestException);
      expect(() => safeStoredExtension(name)).toThrow(BadRequestException);
    });

    it('giữ đuôi an toàn, chuẩn chữ thường', () => {
      expect(safeStoredExtension('Bao Gia.PDF')).toBe('.pdf');
      expect(safeStoredExtension('a.xlsx')).toBe('.xlsx');
      expect(safeStoredExtension('clip.mp4')).toBe('.mp4');
    });

    it('đuôi lạ hoặc không có đuôi → .bin', () => {
      expect(safeStoredExtension('archive.7z')).toBe('.bin');
      expect(safeStoredExtension('README')).toBe('.bin');
      expect(safeStoredExtension('x.exe')).toBe('.bin');
    });

    it('ảnh dự phòng chỉ nhận đuôi ảnh', () => {
      expect(safeImageExtension('a.png')).toBe('.png');
      expect(safeImageExtension('a.GIF')).toBe('.gif');
      expect(safeImageExtension('a.svg')).toBe('.jpg');
      expect(safeImageExtension('a.html')).toBe('.jpg');
      expect(safeImageExtension('noext')).toBe('.jpg');
    });
  });
});
