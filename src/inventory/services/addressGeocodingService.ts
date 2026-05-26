import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

type GeocodableAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  countryCode: string;
};

type GoogleGeocodingResponse = {
  status?: string;
  results?: Array<{
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
    };
  }>;
  error_message?: string;
};

const getGoogleMapsApiKey = () => {
  const value = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!value) {
    throw createError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'GOOGLE_MAPS_API_KEY is required to resolve account address coordinates'
    );
  }

  return value;
};

const normalizeStateCodeForGeocoding = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '';
  }

  const prefixedMatch = /^[A-Z]{2}-(.+)$/i.exec(trimmed);
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1].trim();
  }

  return trimmed;
};

const buildGeocodingQuery = (address: GeocodableAddress) =>
  [
    address.line1?.trim(),
    address.line2?.trim(),
    address.city?.trim(),
    normalizeStateCodeForGeocoding(address.stateCode),
    address.postalCode?.trim(),
    address.countryCode.trim(),
  ]
    .filter(Boolean)
    .join(', ');

export const geocodeAccountAddress = async (address: GeocodableAddress) => {
  const query = buildGeocodingQuery(address);
  if (!query) {
    throw createError(
      StatusCodes.BAD_REQUEST,
      'Complete address required to resolve coordinates'
    );
  }

  const apiKey = getGoogleMapsApiKey();
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', apiKey);

  const response = await fetch(url, {
    method: 'GET',
  });

  if (!response.ok) {
    throw createError(
      StatusCodes.BAD_GATEWAY,
      'Address geocoding request failed'
    );
  }

  const payload = (await response.json()) as GoogleGeocodingResponse;
  const result = payload.results?.[0];
  const latitude = result?.geometry?.location?.lat;
  const longitude = result?.geometry?.location?.lng;

  if (
    payload.status === 'OK' &&
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude)
  ) {
    return {
      latitude,
      longitude,
    };
  }

  if (payload.status === 'ZERO_RESULTS') {
    throw createError(
      StatusCodes.BAD_REQUEST,
      'Unable to resolve coordinates for the provided address'
    );
  }

  throw createError(
    StatusCodes.BAD_GATEWAY,
    payload.error_message?.trim() || 'Address geocoding is unavailable'
  );
};
