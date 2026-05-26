import prismaInventory from '@/lib/prismaInventory';

type OfferLifecycleRecord = {
  addressCountry?: string | null;
  addressState?: string | null;
  status?: 'ACTIVE' | 'INACTIVE' | string | null;
  version?: number | null;
  expiredAt?: Date | null;
};

const isExpired = (expiredAt: Date | null | undefined, now: Date) =>
  expiredAt != null && expiredAt <= now;

export const buildOfferBackedRegion = (
  offer: Pick<OfferLifecycleRecord, 'addressCountry' | 'addressState'>,
) => {
  if (!offer.addressState && !offer.addressCountry) {
    return null;
  }

  return {
    id: null,
    name: offer.addressState ?? null,
    code: offer.addressState ?? null,
    country: offer.addressCountry
      ? {
          id: null,
          name: offer.addressCountry,
          code: offer.addressCountry,
        }
      : null,
  };
};

export const getOfferReadStatus = (offer: Pick<OfferLifecycleRecord, 'expiredAt' | 'status' | 'version'>) => {
  if (offer.expiredAt) {
    return 'EXPIRED';
  }

  if (offer.status === 'ACTIVE') {
    return 'ACTIVE';
  }

  if ((offer.version ?? 0) > 0) {
    return 'DELISTED';
  }

  return 'INACTIVE';
};

export const touchPublishedOffer = async (offerId: number) => {
  const now = new Date();
  const offer = await prismaInventory.offersOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      status: true,
      expiredAt: true,
    },
  });

  if (!offer || offer.status !== 'ACTIVE' || isExpired(offer.expiredAt, now)) {
    return null;
  }

  return prismaInventory.offersOffer.update({
    where: { id: offerId },
    data: {
      updatedAt: now,
    },
  });
};

export const delistMirroredOffer = async (offerId: number) => {
  const now = new Date();
  const offer = await prismaInventory.offersOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      status: true,
      expiredAt: true,
    },
  });

  if (!offer || offer.status !== 'ACTIVE' || isExpired(offer.expiredAt, now)) {
    return null;
  }

  return prismaInventory.offersOffer.update({
    where: { id: offerId },
    data: {
      status: 'INACTIVE',
      version: {
        increment: 1,
      },
    },
  });
};
