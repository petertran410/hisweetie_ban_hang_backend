import {
  isPrivateUploadPath,
  privateUploadsGuard,
} from './private-uploads.middleware';

describe('private-uploads.middleware', () => {
  describe('isPrivateUploadPath', () => {
    it.each([
      '/contracts/contract-17-signed-1731234567890.pdf',
      '/contracts',
      '/contracts/',
      '/CONTRACTS/x.pdf',
      '/Contracts/x.pdf',
      '//contracts/x.pdf',
      '/./contracts/x.pdf',
      '/a/../contracts/x.pdf',
      '/a/..%2Fcontracts/x.pdf',
      '/%63ontracts/x.pdf',
      '/products/..%2F..%2Fcontracts/x.pdf',
      '/a\\..\\contracts\\x.pdf',
    ])('chặn %p', (p) => {
      expect(isPrivateUploadPath(p)).toBe(true);
    });

    it.each([
      '/bao-don/1731234567890-abc.jpg',
      '/products/cong-bo/x.pdf',
      '/contracts-old/x.pdf',
      '/x/contracts/y.pdf',
      '/smax-chat/abcd/file.pdf',
      '/',
    ])('cho qua %p', (p) => {
      expect(isPrivateUploadPath(p)).toBe(false);
    });

    it.each(['/%E0%A4%A', '/a%00b', '/%zz'])(
      'đường dẫn hỏng %p → null',
      (p) => {
        expect(isPrivateUploadPath(p)).toBeNull();
      },
    );
  });

  describe('privateUploadsGuard', () => {
    function run(path: string) {
      const res: any = { statusCode: 0 };
      res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
      });
      res.end = jest.fn();
      const next = jest.fn();
      privateUploadsGuard({ path } as any, res, next);
      return { res, next };
    }

    it('thư mục riêng tư → 404, không gọi next', () => {
      const { res, next } = run('/contracts/x.pdf');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    });

    it('đường dẫn hỏng → 400', () => {
      const { res, next } = run('/%zz');
      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('file thường → next()', () => {
      const { res, next } = run('/bao-don/a.jpg');
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
