import { MovementDirection } from '@/lib/prismaInventoryTypes';
import { enqueueOffersStockSync } from '@/services/offersStockSyncQueue';

type NotifyOffersOnZeroStockInput = {
  sellerIdentifier: string;
  itemCode: string;
  direction: MovementDirection;
  previousQuantity: number;
  nextQuantity: number;
  deduplicationKey: string;
};

const shouldNotifyOffersOnZeroStock = ({
  direction,
  previousQuantity,
  nextQuantity,
}: Pick<
  NotifyOffersOnZeroStockInput,
  'direction' | 'previousQuantity' | 'nextQuantity'
>) =>
  direction === MovementDirection.OUT &&
  previousQuantity > 0 &&
  nextQuantity === 0;

export const notifyOffersOnZeroStock = async ({
  sellerIdentifier,
  itemCode,
  direction,
  previousQuantity,
  nextQuantity,
  deduplicationKey,
}: NotifyOffersOnZeroStockInput) => {
  if (
    !shouldNotifyOffersOnZeroStock({
      direction,
      previousQuantity,
      nextQuantity,
    })
  ) {
    return;
  }

  await enqueueOffersStockSync(
    {
      sellerIdentifier,
      itemCode,
      direction: 'OUT',
    },
    {
      deduplicationKey,
    },
  );
};
