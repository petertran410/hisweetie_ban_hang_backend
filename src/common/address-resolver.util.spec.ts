import { pickCustomerAddress } from './address-resolver.util';

describe('pickCustomerAddress', () => {
  const addresses = [
    {
      id: 1,
      address: '1 Láng Hạ',
      wardName: 'Phường Láng Hạ',
      isDefault: true,
    },
    {
      id: 2,
      address: '225 Phố Đại Từ',
      wardName: 'Phường Đại Kim',
      newWardName: 'Phường Định Công',
      isDefault: false,
    },
  ];

  it('khớp số nhà/đường trước', () => {
    expect(
      pickCustomerAddress(addresses, { address: ' 225 phố đại từ ' })?.id,
    ).toBe(2);
  });

  it('không khớp đường → khớp phường mới hoặc cũ', () => {
    expect(
      pickCustomerAddress(addresses, {
        address: 'Số 252 Đại Từ',
        wardName: 'Phường Đại Kim',
      })?.id,
    ).toBe(2);
    expect(
      pickCustomerAddress(addresses, { wardName: 'Phường Định Công' })?.id,
    ).toBe(2);
  });

  it('không khớp gì / không có delivery → địa chỉ mặc định', () => {
    expect(pickCustomerAddress(addresses, { address: 'X' })?.id).toBe(1);
    expect(pickCustomerAddress(addresses, null)?.id).toBe(1);
    expect(pickCustomerAddress([], null)).toBeNull();
  });
});
