export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'superadmin' | 'admin' | 'staff' | 'member';
  email?: string;
  emailVerified?: boolean;
  passwordSetupRequired?: boolean;
  profile?: {firstName: string; lastName: string; country: string; racingRole: string};
}

export interface Message {
  id: string;
  from: string;
  body: string;
  sentAt: string; // ISO timestamp
  mine: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  participants: string[];
  lastMessage: string;
  lastMessageAt: string;
  unread: number;
  messages: Message[];
}

export type InventoryStatus = 'Active' | 'Resting' | 'In training' | 'For sale' | 'Retired';

export interface InventoryItem {
  id: string;
  saddlecloth: number;
  silksColor: string;
  coatColor: string;
  maneColor: string;
  blaze: boolean;
  horseName: string;
  breed: string;
  age: number;
  sex: 'Colt' | 'Filly' | 'Mare' | 'Stallion' | 'Gelding';
  status: InventoryStatus;
  stable: string;
  valueUsd: number;
  acquiredAt: string;
}

export type TrackerStatus = 'Race ready' | 'In training' | 'Recovering' | 'Entered' | 'Resting';

export interface TrackedHorse {
  id: string;
  saddlecloth: number;
  silksColor: string;
  coatColor: string;
  maneColor: string;
  blaze: boolean;
  name: string;
  breed: string;
  age: number;
  trainer: string;
  jockey: string;
  status: TrackerStatus;
  condition: number; // 0-100
  form: string; // recent finishes, most recent first e.g. "1-3-2-1"
  lastWorkout: string;
  nextRace: string | null;
  location: string;
}
