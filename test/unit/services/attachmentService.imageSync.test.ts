import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockTx = {
  attachment: {
    findFirst: jest.fn<() => Promise<{ id: number } | null>>(),
    findUnique: jest.fn<() => Promise<ReturnType<typeof createStoredAttachment> | null>>(),
    create: jest.fn<() => Promise<ReturnType<typeof createStoredAttachment>>>(),
    delete: jest.fn<() => Promise<ReturnType<typeof createStoredAttachment>>>(),
  },
  item: {
    findUnique: jest.fn<() => Promise<{ mainImageId: number | null } | null>>(),
    update: jest.fn(),
  },
};

const mockPrismaInventory = {
  $transaction: jest.fn(),
};

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

import { createAttachment, deleteAttachment } from '@/services/attachmentService';

const user = {
  userIdentifier: 'user-1',
  userName: 'Abdul',
  userRoles: [],
  accountIdentifier: 'acct-1',
  accountName: 'Account 1',
  accountType: 'BUSINESS',
  local: true,
  online: true,
  isAdmin: true,
};

const createStoredAttachment = (
  overrides: Partial<{
    id: number;
    blobId: number;
    attachableId: number;
    attachableType: string;
    attachmentType: string;
  }> = {},
) => ({
  id: 41,
  blobId: 301,
  attachableId: 12,
  attachableType: 'InventoryItem',
  attachmentType: 'IMAGE',
  metadata: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
  ...overrides,
});

describe('attachmentService image sync behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(mockTx),
    );
  });

  it('sets mainImageId when creating the first InventoryItem image', async () => {
    const createdAttachment = createStoredAttachment({ id: 81 });

    mockTx.attachment.findFirst.mockResolvedValue(null);
    mockTx.attachment.create.mockResolvedValue(createdAttachment);
    mockTx.item.findUnique.mockResolvedValue({ mainImageId: null });

    const result = await createAttachment(user as any, {
      blobId: 301,
      attachableId: 12,
      attachableType: 'InventoryItem',
    });

    expect(result).toEqual({
      attachment: createdAttachment,
      didChangeImageState: true,
    });
    expect(mockTx.item.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { mainImageId: 81 },
    });
  });

  it('does not update mainImageId when creating a non-InventoryItem attachment', async () => {
    const createdAttachment = createStoredAttachment({
      id: 91,
      attachableId: 77,
      attachableType: 'Product',
    });

    mockTx.attachment.findFirst.mockResolvedValue(null);
    mockTx.attachment.create.mockResolvedValue(createdAttachment);

    const result = await createAttachment(user as any, {
      blobId: 301,
      attachableId: 77,
      attachableType: 'Product',
    });

    expect(result).toEqual({
      attachment: createdAttachment,
      didChangeImageState: false,
    });
    expect(mockTx.item.findUnique).not.toHaveBeenCalled();
    expect(mockTx.item.update).not.toHaveBeenCalled();
  });

  it('reports no image-state change when create is a duplicate InventoryItem attachment and mainImageId is already set', async () => {
    const existingAttachment = createStoredAttachment({ id: 95 });

    mockTx.attachment.findFirst.mockResolvedValue(existingAttachment);
    mockTx.item.findUnique.mockResolvedValue({ mainImageId: 95 });

    const result = await createAttachment(user as any, {
      blobId: 301,
      attachableId: 12,
      attachableType: 'InventoryItem',
    });

    expect(result).toEqual({
      attachment: existingAttachment,
      didChangeImageState: false,
    });
    expect(mockTx.attachment.create).not.toHaveBeenCalled();
    expect(mockTx.item.update).not.toHaveBeenCalled();
  });

  it('reassigns mainImageId to the next image when deleting the current main attachment', async () => {
    const deletedAttachment = createStoredAttachment({ id: 51 });

    mockTx.attachment.findUnique.mockResolvedValue(deletedAttachment);
    mockTx.item.findUnique.mockResolvedValue({ mainImageId: 51 });
    mockTx.attachment.findFirst.mockResolvedValue({ id: 66 });
    mockTx.attachment.delete.mockResolvedValue(deletedAttachment);

    await deleteAttachment(user as any, { id: 51 });

    expect(mockTx.item.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { mainImageId: 66 },
    });
  });

  it('clears mainImageId when deleting the last remaining main attachment', async () => {
    const deletedAttachment = createStoredAttachment({ id: 61 });

    mockTx.attachment.findUnique.mockResolvedValue(deletedAttachment);
    mockTx.item.findUnique.mockResolvedValue({ mainImageId: 61 });
    mockTx.attachment.findFirst.mockResolvedValue(null);
    mockTx.attachment.delete.mockResolvedValue(deletedAttachment);

    await deleteAttachment(user as any, { id: 61 });

    expect(mockTx.item.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { mainImageId: null },
    });
  });
});
