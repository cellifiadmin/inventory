export type AccountType = 'BUSINESS' | 'PERSONAL';
export type UserType = 'ADMIN' | 'NORMAL';

export type AuthorizerHomeAddress = {
    line1: string | null;
    line2: string | null;
    city: string | null;
    stateCode: string | null;
    postalCode: string | null;
    countryCode: string | null;
    lat: number | null;
    lng: number | null;
};

export interface FinalAuthUser {
    userIdentifier: string;
    userName: string | null;
    userUsername?: string | null;
    userEmail?: string | null;
    userType?: UserType | null;
    userRoles: string[];
    accountIdentifier?: string;
    accountName?: string | null;
    accountType?: AccountType | null;
    online?: boolean;
    local?: boolean;
    homeAddress?: AuthorizerHomeAddress | null;
    isAdmin?: boolean;
    realm?: string | null;
    [key: string]: unknown;
}

export type AuthUserType = FinalAuthUser;
