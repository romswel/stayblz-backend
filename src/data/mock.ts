import { Conversation, InventoryItem, TrackedHorse } from '../types';

export const conversations: Conversation[] = [
  {
    id: 'c1',
    title: 'Stable operations',
    participants: ['Miguel Ortega', 'You'],
    lastMessage: 'Silver Comet cleared the vet check — she can rejoin morning gallops.',
    lastMessageAt: '2026-09-05T07:42:00Z',
    unread: 2,
    messages: [
      { id: 'm1', from: 'Miguel Ortega', body: 'Morning. Vet is here for Silver Comet and Iron Duke.', sentAt: '2026-09-05T06:10:00Z', mine: false },
      { id: 'm2', from: 'You', body: 'Thanks Miguel. Let me know the results as soon as they are in.', sentAt: '2026-09-05T06:14:00Z', mine: true },
      { id: 'm3', from: 'Miguel Ortega', body: 'Iron Duke needs two more days of rest for the near-fore.', sentAt: '2026-09-05T07:40:00Z', mine: false },
      { id: 'm4', from: 'Miguel Ortega', body: 'Silver Comet cleared the vet check — she can rejoin morning gallops.', sentAt: '2026-09-05T07:42:00Z', mine: false }
    ]
  },
  {
    id: 'c2',
    title: 'Race entries — Provincial Cup',
    participants: ['Anna Reyes', 'You'],
    lastMessage: 'Entries close Tuesday 5 PM. Confirm Night Parade for the 1400m?',
    lastMessageAt: '2026-09-04T16:05:00Z',
    unread: 1,
    messages: [
      { id: 'm1', from: 'Anna Reyes', body: 'Provincial Cup card is out. Three races fit our string.', sentAt: '2026-09-04T15:20:00Z', mine: false },
      { id: 'm2', from: 'You', body: 'Send the conditions over — weights and distances.', sentAt: '2026-09-04T15:31:00Z', mine: true },
      { id: 'm3', from: 'Anna Reyes', body: 'Entries close Tuesday 5 PM. Confirm Night Parade for the 1400m?', sentAt: '2026-09-04T16:05:00Z', mine: false }
    ]
  },
  {
    id: 'c3',
    title: 'Feed & supplies',
    participants: ['Bicol AgriSupply', 'You'],
    lastMessage: 'Order #4471 delivered: 40 bags premium oats, 12 bales lucerne.',
    lastMessageAt: '2026-09-03T11:12:00Z',
    unread: 0,
    messages: [
      { id: 'm1', from: 'You', body: 'Please schedule the monthly feed delivery for Wednesday.', sentAt: '2026-09-02T09:00:00Z', mine: true },
      { id: 'm2', from: 'Bicol AgriSupply', body: 'Confirmed for Wednesday morning.', sentAt: '2026-09-02T09:22:00Z', mine: false },
      { id: 'm3', from: 'Bicol AgriSupply', body: 'Order #4471 delivered: 40 bags premium oats, 12 bales lucerne.', sentAt: '2026-09-03T11:12:00Z', mine: false }
    ]
  },
  {
    id: 'c4',
    title: 'Jockey bookings',
    participants: ['R. Villanueva', 'You'],
    lastMessage: 'I can take the ride on Bravado Star if the barrier draw is kind.',
    lastMessageAt: '2026-09-02T19:48:00Z',
    unread: 0,
    messages: [
      { id: 'm1', from: 'You', body: 'Are you available for Sunday, race 6?', sentAt: '2026-09-02T18:30:00Z', mine: true },
      { id: 'm2', from: 'R. Villanueva', body: 'I can take the ride on Bravado Star if the barrier draw is kind.', sentAt: '2026-09-02T19:48:00Z', mine: false }
    ]
  }
];

export const inventory: InventoryItem[] = [
  { id: 'h1', coatColor: '#9FA6AD', maneColor: '#6f767d', blaze: true, saddlecloth: 1, silksColor: '#1E6B48', horseName: 'Silver Comet', breed: 'Thoroughbred', age: 4, sex: 'Mare', status: 'Active', stable: 'Barn A · Stall 3', valueUsd: 185000, acquiredAt: '2024-03-18' },
  { id: 'h2', coatColor: '#4A3226', maneColor: '#2c1d15', blaze: false, saddlecloth: 2, silksColor: '#8A1C2B', horseName: 'Iron Duke', breed: 'Thoroughbred', age: 5, sex: 'Gelding', status: 'Resting', stable: 'Barn A · Stall 7', valueUsd: 142000, acquiredAt: '2023-11-02' },
  { id: 'h3', coatColor: '#2B2E33', maneColor: '#17191c', blaze: false, saddlecloth: 3, silksColor: '#1F3A6E', horseName: 'Night Parade', breed: 'Thoroughbred', age: 3, sex: 'Colt', status: 'In training', stable: 'Barn B · Stall 1', valueUsd: 210000, acquiredAt: '2025-06-09' },
  { id: 'h4', coatColor: '#8A4B2A', maneColor: '#5c3018', blaze: true, saddlecloth: 4, silksColor: '#B7891F', horseName: 'Bravado Star', breed: 'Arabian', age: 6, sex: 'Stallion', status: 'Active', stable: 'Barn B · Stall 4', valueUsd: 98000, acquiredAt: '2022-08-27' },
  { id: 'h5', coatColor: '#6B4226', maneColor: '#3d2415', blaze: false, saddlecloth: 5, silksColor: '#4A2E6F', horseName: 'Monsoon Lily', breed: 'Thoroughbred', age: 4, sex: 'Filly', status: 'In training', stable: 'Barn C · Stall 2', valueUsd: 156000, acquiredAt: '2024-12-14' },
  { id: 'h6', coatColor: '#C9A15C', maneColor: '#8a6b39', blaze: true, saddlecloth: 6, silksColor: '#2B6E6E', horseName: 'Quarry Lane', breed: 'Quarter Horse', age: 7, sex: 'Gelding', status: 'For sale', stable: 'Barn C · Stall 6', valueUsd: 61000, acquiredAt: '2021-04-30' },
  { id: 'h7', coatColor: '#8C7F76', maneColor: '#5e544d', blaze: false, saddlecloth: 7, silksColor: '#5A5F66', horseName: 'Old Regiment', breed: 'Thoroughbred', age: 11, sex: 'Gelding', status: 'Retired', stable: 'Paddock 2', valueUsd: 18000, acquiredAt: '2018-02-11' }
];

export const horses: TrackedHorse[] = [
  { id: 'h1', coatColor: '#9FA6AD', maneColor: '#6f767d', blaze: true, saddlecloth: 1, silksColor: '#1E6B48', name: 'Silver Comet', breed: 'Thoroughbred', age: 4, trainer: 'Miguel Ortega', jockey: 'R. Villanueva', status: 'Race ready', condition: 92, form: '1-2-1-3', lastWorkout: '2026-09-04 · 1000m breeze, 58.4s', nextRace: 'Sep 13 · Naga Turf Club · R5, 1200m', location: 'Home track' },
  { id: 'h3', coatColor: '#2B2E33', maneColor: '#17191c', blaze: false, saddlecloth: 3, silksColor: '#1F3A6E', name: 'Night Parade', breed: 'Thoroughbred', age: 3, trainer: 'Anna Reyes', jockey: 'D. Santos', status: 'Entered', condition: 88, form: '2-1-4', lastWorkout: '2026-09-03 · 1200m gallop, even tempo', nextRace: 'Sep 08 · Provincial Cup · R3, 1400m', location: 'Home track' },
  { id: 'h4', coatColor: '#8A4B2A', maneColor: '#5c3018', blaze: true, saddlecloth: 4, silksColor: '#B7891F', name: 'Bravado Star', breed: 'Arabian', age: 6, trainer: 'Miguel Ortega', jockey: 'R. Villanueva', status: 'In training', condition: 81, form: '3-3-1-5', lastWorkout: '2026-09-05 · Hill work + pool session', nextRace: 'Sep 20 · Naga Turf Club · R6, 1600m', location: 'Home track' },
  { id: 'h5', coatColor: '#6B4226', maneColor: '#3d2415', blaze: false, saddlecloth: 5, silksColor: '#4A2E6F', name: 'Monsoon Lily', breed: 'Thoroughbred', age: 4, trainer: 'Anna Reyes', jockey: 'Unassigned', status: 'In training', condition: 76, form: '5-2-2', lastWorkout: '2026-09-04 · 800m easy canter', nextRace: null, location: 'Barn C' },
  { id: 'h2', coatColor: '#4A3226', maneColor: '#2c1d15', blaze: false, saddlecloth: 2, silksColor: '#8A1C2B', name: 'Iron Duke', breed: 'Thoroughbred', age: 5, trainer: 'Miguel Ortega', jockey: 'D. Santos', status: 'Recovering', condition: 58, form: '1-6-2-1', lastWorkout: '2026-08-29 · Walker only (vet plan)', nextRace: null, location: 'Vet paddock' },
  { id: 'h6', coatColor: '#C9A15C', maneColor: '#8a6b39', blaze: true, saddlecloth: 6, silksColor: '#2B6E6E', name: 'Quarry Lane', breed: 'Quarter Horse', age: 7, trainer: '—', jockey: '—', status: 'Resting', condition: 70, form: '4-5-3', lastWorkout: '2026-08-20 · Paddock turnout', nextRace: null, location: 'Paddock 1' }
];
