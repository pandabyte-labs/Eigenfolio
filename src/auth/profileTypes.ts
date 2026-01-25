export type ProfileId = string;

export type ProfileSummary = {
  id: ProfileId;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileOverview = {
  profiles: ProfileSummary[];
  hasLegacyData: boolean;
};

export type ProfilesIndex = {
  currentProfileId: ProfileId | null;
  profiles: ProfileSummary[];
};
