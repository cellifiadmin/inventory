import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import {
  getAccountAddressByType,
  listAccountAddresses,
} from '@/inventory/services/accountAddressService';
import type { AuthUserType } from '@/types/userType';

const buildSystemAuthUser = (accountIdentifier: string): AuthUserType => ({
  accountIdentifier,
  userIdentifier: 'system',
  userName: null,
  userRoles: [],
});

const getHomeAddressForUser = (user: AuthUserType) => {
  if (!user.homeAddress) {
    throw createError(StatusCodes.BAD_REQUEST, 'Home address required');
  }

  return {
    line1: user.homeAddress.line1 ?? '',
    line2: user.homeAddress.line2 ?? null,
    city: user.homeAddress.city ?? '',
    stateCode: user.homeAddress.stateCode ?? '',
    postalCode: user.homeAddress.postalCode ?? '',
    countryCode: user.homeAddress.countryCode ?? '',
    latitude: user.homeAddress.lat ?? null,
    longitude: user.homeAddress.lng ?? null,
    type: 'HOME_ADDRESS',
    label: null,
  };
};

export const getUserInventoryAddress = async (user: AuthUserType) => {
  const accountType = user.accountType ?? null;
  const accountIdentifier = user.accountIdentifier;

  if (!accountType) {
    throw createError(StatusCodes.BAD_REQUEST, 'Account type required');
  }

  if (accountType === 'BUSINESS') {
    if (!accountIdentifier) {
      throw createError(StatusCodes.BAD_REQUEST, 'Account identifier required');
    }

    const address = await getAccountAddressByType(accountIdentifier, 'WAREHOUSE');

    if (!address) {
      throw createError(StatusCodes.BAD_REQUEST, 'Warehouse address required');
    }

    return address;
  }

  return getHomeAddressForUser(user);
};

export const isUserAccountLocal = async (user: AuthUserType): Promise<boolean> => {
  return user.local ?? false;
};

export const isUserAccountOnline = async (user: AuthUserType): Promise<boolean> => {
  return user.online ?? false;
};

export const getPrimaryAddress = async (accountIdentifier: string) => {
  const addresses = await listAccountAddresses({
    authUser: buildSystemAuthUser(accountIdentifier),
  });

  const address = addresses.find((item) => item.type === 'WAREHOUSE') || addresses[0];

  if (!address) {
    throw createError(
      StatusCodes.BAD_REQUEST,
      'No primary address found. Please add an address.',
    );
  }

  return address;
};

export const getPickupAddress = async (accountIdentifier: string) => {
  const pickupAddress = await getAccountAddressByType(accountIdentifier, 'PICKUP');

  if (!pickupAddress) {
    throw createError(StatusCodes.BAD_REQUEST, 'Pickup address required for local offers');
  }

  return pickupAddress;
};

export const getWarehouseAddress = async (accountIdentifier: string) => {
  const warehouseAddress = await getAccountAddressByType(accountIdentifier, 'WAREHOUSE');

  if (!warehouseAddress) {
    throw createError(
      StatusCodes.BAD_REQUEST,
      'Warehouse address required for business accounts',
    );
  }

  return warehouseAddress;
};

export const getAddressesByAccountIdentifier = async (accountIdentifier: string) => {
  return listAccountAddresses({
    authUser: buildSystemAuthUser(accountIdentifier),
  });
};
