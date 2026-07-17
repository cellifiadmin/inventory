import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import type { AuthUserType } from '@/types/userType';
import { geocodeAccountAddress } from '@/inventory/services/addressGeocodingService';

export const ACCOUNT_ADDRESS_TYPES = [
  'WAREHOUSE',
  'PICKUP',
] as const;

export type AccountAddressType = (typeof ACCOUNT_ADDRESS_TYPES)[number];

export type AccountAddressInput = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  countryCode: string;
  latitude?: number | null;
  longitude?: number | null;
  label?: string | null;
};

type SaveAccountAddressParams = {
  authUser: AuthUserType;
  type: string;
  address: AccountAddressInput;
};

type SaveAccountAddressByAccountIdentifierParams = {
  accountIdentifier: string;
  type: string;
  address: AccountAddressInput;
};

type DeleteAccountAddressParams = {
  authUser: AuthUserType;
  type: string;
};

type ListAccountAddressesParams = {
  authUser: AuthUserType;
};

type UpsertApprovedAccountAddressesParams = {
  accountIdentifier: string;
  addresses: Array<AccountAddressInput & { type: string }>;
};

const normalizeTrimmed = (value?: string | null): string | null => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeCountryCode = (value?: string | null): string | null => {
  const trimmed = normalizeTrimmed(value);
  return trimmed ? trimmed.toUpperCase() : null;
};

const normalizeCoordinate = ({
  value,
  field,
  min,
  max,
}: {
  value?: number | null;
  field: 'latitude' | 'longitude';
  min: number;
  max: number;
}): number | null => {
  if (value == null) {
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  if (value < min || value > max) {
    throw createError(
      StatusCodes.BAD_REQUEST,
      `${field} must be between ${min} and ${max}`
    );
  }

  return value;
};

const normalizeAccountAddressType = (value?: string | null): AccountAddressType | null => {
  const trimmed = normalizeTrimmed(value);
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toUpperCase();
  return ACCOUNT_ADDRESS_TYPES.includes(normalized as AccountAddressType)
    ? (normalized as AccountAddressType)
    : null;
};

const requireNormalizedAccountIdentifier = (accountIdentifier?: string | null): string => {
  const normalizedAccountIdentifier = normalizeTrimmed(accountIdentifier);

  if (!normalizedAccountIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Account identifier required');
  }

  return normalizedAccountIdentifier;
};

const requireAccountIdentifier = (authUser: AuthUserType): string => {
  return requireNormalizedAccountIdentifier(authUser.accountIdentifier);
};

const normalizeAddressInput = (input: AccountAddressInput) => {
  const countryCode = normalizeCountryCode(input.countryCode);

  if (!countryCode) {
    throw createError(StatusCodes.BAD_REQUEST, 'countryCode is required');
  }

  return {
    line1: normalizeTrimmed(input.line1),
    line2: normalizeTrimmed(input.line2),
    city: normalizeTrimmed(input.city),
    stateCode: normalizeTrimmed(input.stateCode),
    postalCode: normalizeTrimmed(input.postalCode),
    countryCode,
    latitude: normalizeCoordinate({
      value: input.latitude,
      field: 'latitude',
      min: -90,
      max: 90,
    }),
    longitude: normalizeCoordinate({
      value: input.longitude,
      field: 'longitude',
      min: -180,
      max: 180,
    }),
    label: normalizeTrimmed(input.label),
  };
};

const requiresDerivedCoordinates = (
  address: ReturnType<typeof normalizeAddressInput>
) => address.latitude == null || address.longitude == null;

const isGeocodableAccountAddress = (
  address: ReturnType<typeof normalizeAddressInput>
) =>
  Boolean(
    address.line1 &&
      address.city &&
      address.stateCode &&
      address.postalCode &&
      address.countryCode
  );

const ensureAddressCoordinates = async (
  address: ReturnType<typeof normalizeAddressInput>
) => {
  if (!requiresDerivedCoordinates(address)) {
    return address;
  }

  if (!isGeocodableAccountAddress(address)) {
    throw createError(
      StatusCodes.BAD_REQUEST,
      'Complete address required to resolve coordinates'
    );
  }

  const coordinates = await geocodeAccountAddress(address);
  return {
    ...address,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };
};

const mapAccountAddressRecord = (
  record: Awaited<ReturnType<typeof prismaInventory.accountAddress.findFirstOrThrow>>,
) => ({
  id: record.id,
  accountIdentifier: record.accountIdentifier,
  addressableId: record.accountIdentifier,
  addressableType: 'Account',
  type: record.type,
  line1: record.line1,
  line2: record.line2,
  city: record.city,
  stateCode: record.stateCode,
  postalCode: record.postalCode,
  countryCode: record.countryCode,
  latitude: record.latitude,
  longitude: record.longitude,
  label: record.label,
  isPrimary: record.type === 'WAREHOUSE',
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt,
});

const mapAccountAddressList = (
  records: Array<Awaited<ReturnType<typeof prismaInventory.accountAddress.findFirstOrThrow>>>,
) => records.map(mapAccountAddressRecord);

export const listAccountAddressesByAccountIdentifier = async (
  accountIdentifier: string,
) => {
  const normalizedAccountIdentifier = requireNormalizedAccountIdentifier(accountIdentifier);

  const records = await prismaInventory.accountAddress.findMany({
    where: {
      accountIdentifier: normalizedAccountIdentifier,
      type: {
        in: [...ACCOUNT_ADDRESS_TYPES],
      },
      deletedAt: null,
    },
    orderBy: [{ type: 'asc' }],
  });

  return mapAccountAddressList(records);
};

export const listAccountAddresses = async ({
  authUser,
}: ListAccountAddressesParams) => {
  const accountIdentifier = requireAccountIdentifier(authUser);
  return listAccountAddressesByAccountIdentifier(accountIdentifier);
};

export const saveAccountAddress = async ({
  authUser,
  type,
  address,
}: SaveAccountAddressParams) => {
  const accountIdentifier = requireAccountIdentifier(authUser);

  return upsertAccountAddressByAccountIdentifier({
    accountIdentifier,
    type,
    address,
  });
};

export const upsertAccountAddressByAccountIdentifier = async ({
  accountIdentifier,
  type,
  address,
}: SaveAccountAddressByAccountIdentifierParams) => {
  const normalizedAccountIdentifier = requireNormalizedAccountIdentifier(accountIdentifier);
  const normalizedType = normalizeAccountAddressType(type);

  if (!normalizedType) {
    throw createError(StatusCodes.BAD_REQUEST, 'Valid account address type required');
  }

  const normalizedAddress = await ensureAddressCoordinates(
    normalizeAddressInput(address)
  );

  const record = await prismaInventory.accountAddress.upsert({
    where: {
      accountIdentifier_type: {
        accountIdentifier: normalizedAccountIdentifier,
        type: normalizedType,
      },
    },
    update: {
      ...normalizedAddress,
      deletedAt: null,
    },
    create: {
      accountIdentifier: normalizedAccountIdentifier,
      type: normalizedType,
      ...normalizedAddress,
    },
  });

  return mapAccountAddressRecord(record);
};

export const deleteAccountAddress = async ({
  authUser,
  type,
}: DeleteAccountAddressParams) => {
  const accountIdentifier = requireAccountIdentifier(authUser);
  const normalizedType = normalizeAccountAddressType(type);

  if (!normalizedType) {
    throw createError(StatusCodes.BAD_REQUEST, 'Valid account address type required');
  }

  const existing = await prismaInventory.accountAddress.findUnique({
    where: {
      accountIdentifier_type: {
        accountIdentifier,
        type: normalizedType,
      },
    },
  });

  if (!existing || existing.deletedAt) {
    throw createError(StatusCodes.NOT_FOUND, 'Account address not found');
  }

  const deleted = await prismaInventory.accountAddress.update({
    where: { id: existing.id },
    data: {
      deletedAt: new Date(),
    },
  });

  return mapAccountAddressRecord(deleted);
};

export const upsertApprovedAccountAddresses = async ({
  accountIdentifier,
  addresses,
}: UpsertApprovedAccountAddressesParams) => {
  const normalizedAccountIdentifier = requireNormalizedAccountIdentifier(accountIdentifier);

  const seenTypes = new Set<AccountAddressType>();
  const normalizedAddresses = await Promise.all(
    addresses.map(async (rawAddress) => {
    const normalizedType = normalizeAccountAddressType(rawAddress.type);
    if (!normalizedType) {
      throw createError(StatusCodes.BAD_REQUEST, 'Valid account address type required');
    }

    if (seenTypes.has(normalizedType)) {
      throw createError(
        StatusCodes.BAD_REQUEST,
        `Duplicate ${normalizedType} address in approved set`,
      );
    }
    seenTypes.add(normalizedType);

    const normalizedAddress = await ensureAddressCoordinates(
      normalizeAddressInput(rawAddress)
    );

    return {
      type: normalizedType,
      ...normalizedAddress,
    };
    })
  );

  const activeTypes = normalizedAddresses.map((address) => address.type);

  await prismaInventory.$transaction(async (tx) => {
    await tx.accountAddress.updateMany({
      where: {
        accountIdentifier: normalizedAccountIdentifier,
        deletedAt: null,
        ...(activeTypes.length > 0
          ? {
              type: {
                notIn: activeTypes,
              },
            }
          : {}),
      },
      data: {
        deletedAt: new Date(),
      },
    });

    for (const normalizedAddress of normalizedAddresses) {
      await tx.accountAddress.upsert({
        where: {
          accountIdentifier_type: {
            accountIdentifier: normalizedAccountIdentifier,
            type: normalizedAddress.type,
          },
        },
        update: {
          ...normalizedAddress,
          deletedAt: null,
        },
        create: {
          accountIdentifier: normalizedAccountIdentifier,
          ...normalizedAddress,
        },
      });
    }
  });

  const records = await prismaInventory.accountAddress.findMany({
    where: {
      accountIdentifier: normalizedAccountIdentifier,
      type: {
        in: [...ACCOUNT_ADDRESS_TYPES],
      },
      deletedAt: null,
    },
    orderBy: [{ type: 'asc' }],
  });

  return mapAccountAddressList(records);
};

export const getAccountAddressByType = async (
  accountIdentifier: string,
  type: string,
) => {
  const normalizedAccountIdentifier = requireNormalizedAccountIdentifier(accountIdentifier);
  const normalizedType = normalizeAccountAddressType(type);

  if (!normalizedType) {
    throw createError(StatusCodes.BAD_REQUEST, 'Valid account address type required');
  }

  const record = await prismaInventory.accountAddress.findFirst({
    where: {
      accountIdentifier: normalizedAccountIdentifier,
      type: normalizedType,
      deletedAt: null,
    },
  });

  if (!record) {
    throw createError(StatusCodes.BAD_REQUEST, `${normalizedType} address required`);
  }

  return mapAccountAddressRecord(record);
};
