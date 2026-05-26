import type { Attachment } from '../../node_modules/.prisma/inventoryClient';
import httpError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import {
  inventoryItemImageRelationsInclude,
  type InventoryItemImageSyncState,
} from '@/inventory/services/notifyOffersOnImageUpdate';
import prismaInventory from '@/lib/prismaInventory';
import type { AuthUserType } from '@/types/userType';

interface DetachAttachmentInput {
    id: number
}

export const deleteAttachment = async (_user: Record<string, any>, input: DetachAttachmentInput): Promise<Attachment> => {
    const { id } = input;

    const attachment = await prismaInventory.$transaction(async (tx) => {
        const attachment = await tx.attachment.findUnique({
            where: { id: id }
        });

        if (!attachment) {
            throw httpError(StatusCodes.NOT_FOUND, 'Attachment not found');
        }

        if (attachment.attachableType === 'InventoryItem') {
            const item = await tx.item.findUnique({
                where: { id: attachment.attachableId },
                select: {
                    mainImageId: true,
                },
            });

            if (item?.mainImageId === attachment.id) {
                const nextMainAttachment = await tx.attachment.findFirst({
                    where: {
                        attachableId: attachment.attachableId,
                        attachableType: 'InventoryItem',
                        attachmentType: 'IMAGE',
                        deletedAt: null,
                        id: {
                            not: attachment.id,
                        },
                    },
                    select: {
                        id: true,
                    },
                    orderBy: {
                        id: 'asc',
                    },
                });

                await tx.item.update({
                    where: { id: attachment.attachableId },
                    data: {
                        mainImageId: nextMainAttachment?.id ?? null,
                    },
                });
            }
        }

        await tx.attachment.delete({
            where: { id: id }
        });

        return attachment;
    });

    return attachment;
} 

interface createAttachmentInput {
    blobId: number;
    attachableId: number;
    attachableType: string;
}

export type CreateAttachmentResult = {
  attachment: Attachment;
  didChangeImageState: boolean;
};

export const createAttachment = async (
  _user: AuthUserType,
  input: createAttachmentInput,
): Promise<CreateAttachmentResult> => {
  const { blobId, attachableId, attachableType } = input;

  return prismaInventory.$transaction(async (tx) => {
    let didChangeImageState = false;

    // Check if attachment already exists, if not create it.
    // Database foreign key constraints will validate that blob and attachable exist.
    let attachment = await tx.attachment.findFirst({
      where: {
        blobId,
        attachableId,
        attachableType,
        attachmentType: 'IMAGE',
      },
    });

    if (!attachment) {
      attachment = await tx.attachment.create({
        data: {
          attachableId,
          attachableType,
          attachmentType: 'IMAGE',
          metadata: {},
          blobId,
        },
      });

      if (attachableType === 'InventoryItem') {
        didChangeImageState = true;
      }
    }

    if (attachableType === 'InventoryItem') {
      const item = await tx.item.findUnique({
        where: { id: attachableId },
        select: {
          mainImageId: true,
        },
      });

      if (item?.mainImageId == null) {
        await tx.item.update({
          where: { id: attachableId },
          data: {
            mainImageId: attachment.id,
          },
        });

        didChangeImageState = true;
      }
    }

    return {
      attachment,
      didChangeImageState,
    };
  });
};

export const getInventoryItemImageSyncState = async (
  id: number,
): Promise<InventoryItemImageSyncState> =>
  prismaInventory.item.findUniqueOrThrow({
    where: { id },
    include: inventoryItemImageRelationsInclude,
  });
