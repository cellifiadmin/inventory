import { z } from 'zod';

import { upsertApprovedAccountAddresses } from '@/inventory/services/accountAddressService';

const approvedAccountAddressSchema = z.object({
  type: z.string().trim().min(1, 'type is required'),
  line1: z.string().optional().nullable(),
  line2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  stateCode: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  countryCode: z.string().trim().min(1, 'countryCode is required'),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  label: z.string().optional().nullable(),
});

const approvedAccountAddressProvisioningEventSchema = z.object({
  accountIdentifier: z.string().trim().min(1, 'accountIdentifier is required'),
  addresses: z.array(approvedAccountAddressSchema),
});

export type ApprovedAccountAddressProvisioningEvent = z.infer<
  typeof approvedAccountAddressProvisioningEventSchema
>;

export const handler = async (event: ApprovedAccountAddressProvisioningEvent) => {
  const input = approvedAccountAddressProvisioningEventSchema.parse(event);
  const visibilityAddress =
    input.addresses.find((address) => address.type.trim().toUpperCase() === 'VISIBILITY') ||
    null;
  const inventoryAddresses = input.addresses.filter(
    (address) => address.type.trim().toUpperCase() !== 'VISIBILITY',
  );

  const data = await upsertApprovedAccountAddresses({
    ...input,
    addresses: inventoryAddresses,
  });

  return {
    success: true,
    message: 'Approved seller addresses provisioned successfully',
    data: {
      inventoryAccountAddresses: data,
      visibilityAddress:
        visibilityAddress == null
          ? null
          : {
              sellerIdentifier: input.accountIdentifier,
              countryCode: visibilityAddress.countryCode,
              stateCode: visibilityAddress.stateCode ?? null,
            },
    },
  };
};
