import { z } from 'zod';

import {
  isGreaterThanOrEqualZeroNumber,
  isGreaterThanZeroInteger,
} from '@/lib/number';
import type { AuthUserType } from '@/types/userType';

const ITEM_KINDS = ['STOCK', 'LISTING'] as const;
const PRODUCT_TYPES = ['PHONE', 'WATCH', 'TABLET', 'ACCESSORY'] as const;

const itemKindSchema = z.enum(ITEM_KINDS);
const productTypeSchema = z.enum(PRODUCT_TYPES);

export const productSnapshotSchema = z.object({
  sellerIdentifier: z.string().min(1, 'Seller identifier required'),
  sku: z.string().min(1, 'SKU required'),
  batteryLevel: z
    .union([
      z
        .string()
        .refine(
          (value) => isGreaterThanOrEqualZeroNumber(value) && Number(value) <= 100,
          'Battery invalid',
        ),
      z
        .number()
        .refine(
          (value) => isGreaterThanOrEqualZeroNumber(value) && Number(value) <= 100,
          'Battery invalid',
        ),
    ])
    .transform((value) => (typeof value === 'string' ? Number(value) : value))
    .nullable()
    .optional(),
  brand: z.object({
    key: z.string().min(1, 'Brand key required'),
    name: z.string().min(1, 'Brand name required'),
  }),
  model: z.object({
    key: z.string().min(1, 'Model key required'),
    name: z.string().min(1, 'Model name required'),
  }),
  color: z.object({
    key: z.string().min(1, 'Color key required'),
    name: z.string().min(1, 'Color name required'),
    hexValue: z.string().nullable().optional(),
  }),
  storage: z.object({
    key: z.string().min(1, 'Storage key required'),
    name: z.string().min(1, 'Storage name required'),
  }),
  condition: z.object({
    key: z.string().min(1, 'Condition key required'),
    label: z.string().min(1, 'Condition label required'),
  }),
  carrier: z
    .object({
      key: z.string().min(1, 'Carrier key required'),
      name: z.string().min(1, 'Carrier name required'),
    })
    .nullable(),
  isUnlocked: z.boolean().optional(),
});

const positiveIntegerSchema = z
  .union([
    z.string().refine((value) => isGreaterThanZeroInteger(value), 'Count invalid'),
    z.number().refine((value) => isGreaterThanZeroInteger(value), 'Count invalid'),
  ])
  .transform((value) => (typeof value === 'string' ? Number.parseInt(value, 10) : value));

const nonNegativeIntegerSchema = z
  .union([
    z
      .string()
      .refine((value) => isGreaterThanOrEqualZeroNumber(value), 'Quantity invalid'),
    z
      .number()
      .refine(
        (value) => Number.isInteger(value) && value >= 0,
        'Quantity invalid',
      ),
  ])
  .transform((value) => (typeof value === 'string' ? Number.parseInt(value, 10) : value));

const componentInputSchema = z
  .object({
    sku: z.string().min(1, 'SKU required'),
    count: positiveIntegerSchema.optional(),
    productType: productTypeSchema,
    imei: z.string().min(1, 'IMEI invalid').optional(),
    fallbackCode: z.string().min(1, 'Fallback code invalid').optional(),
    productSnapshot: productSnapshotSchema,
  })
  .superRefine((data, ctx) => {
    if (data.imei && data.fallbackCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Component cannot include both imei and fallbackCode',
        path: ['fallbackCode'],
      });
    }
  })
  .transform((data) => ({
    ...data,
    count: data.imei || data.fallbackCode ? 1 : data.count ?? 1,
  }));

export const inventoryPhotoSchema = z
  .object({
    blobId: z.coerce.number().optional(),
    attachmentId: z.coerce.number().optional(),
    checksum: z.string().min(1, 'Checksum required'),
    assetRef: z.string().optional(),
    key: z.string().optional(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
  })
  .superRefine((photo, ctx) => {
    if (typeof photo.blobId === 'number') {
      return;
    }

    if (!photo.assetRef?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assetRef required for uploaded photos',
        path: ['assetRef'],
      });
    }

    if (!photo.key?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'key required for uploaded photos',
        path: ['key'],
      });
    }

    if (!photo.mimeType?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mimeType required for uploaded photos',
        path: ['mimeType'],
      });
    }

    if (typeof photo.size !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'size required for uploaded photos',
        path: ['size'],
      });
    }
  });

const inventoryBoundaryBaseSchema = z.object({
  kind: itemKindSchema,
  components: z.array(componentInputSchema).min(1, 'At least one component is required'),
}).strict();

const addDuplicateSerializedComponentIssues = (
  components: Array<{
    imei?: string;
    fallbackCode?: string;
  }>,
  ctx: z.RefinementCtx,
) => {
  const seenImeis = new Set<string>();
  const seenFallbackCodes = new Set<string>();

  components.forEach((component, index) => {
    if (component.imei) {
      if (seenImeis.has(component.imei)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate IMEI in inventory composition',
          path: ['components', index, 'imei'],
        });
      } else {
        seenImeis.add(component.imei);
      }
    }

    if (component.fallbackCode) {
      if (seenFallbackCodes.has(component.fallbackCode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate fallback code in inventory composition',
          path: ['components', index, 'fallbackCode'],
        });
      } else {
        seenFallbackCodes.add(component.fallbackCode);
      }
    }
  });
};

const addPersonalInventoryIssues = (
  user: AuthUserType | undefined,
  data: {
    kind: (typeof ITEM_KINDS)[number];
    components: Array<{
      imei?: string;
      fallbackCode?: string;
    }>;
  },
  ctx: z.RefinementCtx,
) => {
  if (user?.accountType !== 'PERSONAL') {
    return;
  }

  if (data.kind !== 'LISTING') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Personal accounts must submit LISTING inventory',
      path: ['kind'],
    });
  }

  data.components.forEach((component, index) => {
    if (!component.imei && !component.fallbackCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Personal LISTING components require imei or fallbackCode',
        path: ['components', index],
      });
    }
  });
};

const normalizeExplicitEmptyPhotoSelection = <
  T extends {
    photos?: unknown[];
    mainPhotoHash?: string | null;
  },
>(
  data: T,
): T => {
  if (Array.isArray(data.photos) && data.photos.length === 0) {
    return {
      ...data,
      mainPhotoHash: null,
    };
  }

  return data;
};

const buildCreateInventoryItemSchema = (user?: AuthUserType) =>
  inventoryBoundaryBaseSchema
  .extend({
    quantity: nonNegativeIntegerSchema.optional(),
    photos: z.array(inventoryPhotoSchema).optional().default([]),
    mainPhotoHash: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    addDuplicateSerializedComponentIssues(data.components, ctx);

    if (data.kind === 'STOCK' && data.quantity === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Quantity invalid',
        path: ['quantity'],
      });
    }

    addPersonalInventoryIssues(user, data, ctx);
  })
  .transform((data) => {
    const normalizedData = normalizeExplicitEmptyPhotoSelection(data);

    return {
      ...normalizedData,
      quantity:
        normalizedData.kind === 'LISTING'
          ? normalizedData.quantity ?? 1
          : (normalizedData.quantity as number),
    };
  });

const buildWriteInventoryItemSchema = (user?: AuthUserType) =>
  inventoryBoundaryBaseSchema
    .extend({
      quantity: nonNegativeIntegerSchema.optional(),
      photos: z.array(inventoryPhotoSchema).optional().default([]),
      mainPhotoHash: z.string().nullable().optional(),
    })
    .superRefine((data, ctx) => {
      addDuplicateSerializedComponentIssues(data.components, ctx);
      addPersonalInventoryIssues(user, data, ctx);
    })
    .transform((data) => normalizeExplicitEmptyPhotoSelection(data));

const updateInventoryItemSchema = z
  .object({
    quantity: nonNegativeIntegerSchema.optional(),
    photos: z.array(inventoryPhotoSchema).optional(),
    mainPhotoHash: z.string().nullable().optional(),
  })
  .transform((data) => normalizeExplicitEmptyPhotoSelection(data));

const buildResolveInventoryItemSchema = (user?: AuthUserType) =>
  inventoryBoundaryBaseSchema
    .superRefine((data, ctx) => {
      addDuplicateSerializedComponentIssues(data.components, ctx);
      addPersonalInventoryIssues(user, data, ctx);
    })
    .transform((data) => data);

export type InventoryProductSnapshotInput = z.infer<typeof productSnapshotSchema>;
export type InventoryComponentInput = z.infer<typeof componentInputSchema>;
export type CanonicalInventoryComponentInput = InventoryComponentInput;
export type SnapshotBackedInventoryComponentInput = InventoryComponentInput;
export type CreateInventoryItemBoundaryInput = z.infer<
  ReturnType<typeof buildCreateInventoryItemSchema>
>;
export type WriteInventoryBoundaryInput = z.infer<
  ReturnType<typeof buildWriteInventoryItemSchema>
>;
export type UpdateInventoryItemBoundaryInput = z.infer<
  typeof updateInventoryItemSchema
>;
export type ResolveInventoryItemBoundaryInput = z.infer<
  ReturnType<typeof buildResolveInventoryItemSchema>
>;

export const validateCreateInventoryItemInput = (
  input: unknown,
  user?: AuthUserType,
): CreateInventoryItemBoundaryInput => {
  return buildCreateInventoryItemSchema(user).parse(input);
};

export const validateResolveInventoryItemInput = (
  input: unknown,
  user?: AuthUserType,
): ResolveInventoryItemBoundaryInput => {
  return buildResolveInventoryItemSchema(user).parse(input);
};

export const validateWriteInventoryItemInput = (
  input: unknown,
  user?: AuthUserType,
): WriteInventoryBoundaryInput => {
  return buildWriteInventoryItemSchema(user).parse(input);
};

export const validateUpdateInventoryItemInput = (
  input: unknown,
): UpdateInventoryItemBoundaryInput => {
  return updateInventoryItemSchema.parse(input);
};
