export interface User {
  id: string;
  username: string;
  displayName: string;
  /** The role this request acts with (after any "View as" choice). */
  role: 'superadmin' | 'admin' | 'member';
  /** The account's real role. */
  platformRole?: 'superadmin' | 'admin' | 'member';
  actingRole?: 'admin' | 'member' | null;
  accountStatus?: 'active' | 'suspended' | 'closed';
  email?: string;
  emailVerified?: boolean;
  passwordSetupRequired?: boolean;
  mfa?: { enabled: boolean; verified: boolean };
  /** 2-step login is on but this session has not passed it yet. */
  mfaPending?: boolean;
  profile?: {
    firstName: string;
    lastName: string;
    country: string;
    racingRole: string;
    communityRoles?: string[];
    organisation?: string;
    city?: string;
    bio?: string;
  };
  preferences?: { marketingOptIn: boolean; updatesSeenAt: string; updatesPopup: boolean };
}
