// Mock racing data modeled on Equibase-style sections.
// Replace with a licensed data feed (e.g. Equibase/Trackmaster) in production.

export interface RaceEntry {
  pp: number;
  silksColor: string;
  horse: string;
  ml: string; // morning-line odds
  jockey: string;
  trainer: string;
  weight: number;
}

export interface RaceCard {
  raceNo: number;
  postTime: string;
  distance: string;
  surface: string;
  type: string;
  purse: string;
  entries: RaceEntry[];
}

export interface TrackEntries {
  track: string;
  date: string;
  races: RaceCard[];
}

export const entries: TrackEntries[] = [
  {
    track: 'Naga Turf Club',
    date: '2026-09-20',
    races: [
      {
        raceNo: 5,
        postTime: '3:42 PM',
        distance: '1200m',
        surface: 'Turf',
        type: 'Allowance',
        purse: '$85,000',
        entries: [
          { pp: 1, silksColor: '#1E6B48', horse: 'Silver Comet', ml: '5-2', jockey: 'R. Villanueva', trainer: 'M. Ortega', weight: 118 },
          { pp: 2, silksColor: '#8A1C2B', horse: 'Crimson Ledger', ml: '4-1', jockey: 'D. Santos', trainer: 'A. Reyes', weight: 120 },
          { pp: 3, silksColor: '#1F3A6E', horse: 'Harbor Master', ml: '7-2', jockey: 'J. dela Cruz', trainer: 'P. Lim', weight: 119 },
          { pp: 4, silksColor: '#B7891F', horse: 'Golden Tempo', ml: '2-1', jockey: 'L. Mercado', trainer: 'C. Tan', weight: 122 },
          { pp: 5, silksColor: '#4A2E6F', horse: 'Night Market', ml: '8-1', jockey: 'E. Bautista', trainer: 'A. Reyes', weight: 117 },
          { pp: 6, silksColor: '#2B6E6E', horse: 'Paper Lantern', ml: '12-1', jockey: 'F. Ramos', trainer: 'P. Lim', weight: 116 }
        ]
      },
      {
        raceNo: 6,
        postTime: '4:15 PM',
        distance: '1600m',
        surface: 'Turf',
        type: 'Stakes — Provincial Cup Prep',
        purse: '$120,000',
        entries: [
          { pp: 1, silksColor: '#B7891F', horse: 'Bravado Star', ml: '3-1', jockey: 'R. Villanueva', trainer: 'M. Ortega', weight: 121 },
          { pp: 2, silksColor: '#5A5F66', horse: 'Renegade', ml: '5-2', jockey: 'D. Santos', trainer: 'C. Tan', weight: 123 },
          { pp: 3, silksColor: '#1E6B48', horse: 'Counting Stars', ml: '6-1', jockey: 'L. Mercado', trainer: 'A. Reyes', weight: 118 },
          { pp: 4, silksColor: '#8A1C2B', horse: 'Knightsbridge', ml: '9-2', jockey: 'J. dela Cruz', trainer: 'P. Lim', weight: 120 },
          { pp: 5, silksColor: '#1F3A6E', horse: 'Magnitude', ml: '7-1', jockey: 'E. Bautista', trainer: 'C. Tan', weight: 119 }
        ]
      }
    ]
  },
  {
    track: 'Metro Downs',
    date: '2026-09-19',
    races: [
      {
        raceNo: 3,
        postTime: '2:10 PM',
        distance: '1400m',
        surface: 'Dirt',
        type: 'Maiden Special Weight',
        purse: '$62,000',
        entries: [
          { pp: 1, silksColor: '#1F3A6E', horse: 'Night Parade', ml: '2-1', jockey: 'D. Santos', trainer: 'A. Reyes', weight: 118 },
          { pp: 2, silksColor: '#2B6E6E', horse: 'Quiet Thunder', ml: '3-1', jockey: 'F. Ramos', trainer: 'P. Lim', weight: 118 },
          { pp: 3, silksColor: '#B7891F', horse: 'Solar Flare', ml: '9-2', jockey: 'L. Mercado', trainer: 'C. Tan', weight: 118 },
          { pp: 4, silksColor: '#4A2E6F', horse: 'In Our Time', ml: '6-1', jockey: 'E. Bautista', trainer: 'M. Ortega', weight: 118 },
          { pp: 5, silksColor: '#8A1C2B', horse: 'Commandment', ml: '10-1', jockey: 'J. dela Cruz', trainer: 'P. Lim', weight: 118 },
          { pp: 6, silksColor: '#1E6B48', horse: 'White Abarrio', ml: '15-1', jockey: 'G. Flores', trainer: 'C. Tan', weight: 118 }
        ]
      },
      {
        raceNo: 7,
        postTime: '4:48 PM',
        distance: '1800m',
        surface: 'Dirt',
        type: 'Handicap',
        purse: '$95,000',
        entries: [
          { pp: 1, silksColor: '#5A5F66', horse: 'Napoleon Solo', ml: '7-2', jockey: 'R. Villanueva', trainer: 'C. Tan', weight: 124 },
          { pp: 2, silksColor: '#1E6B48', horse: 'Skippylongstocking', ml: '5-2', jockey: 'D. Santos', trainer: 'A. Reyes', weight: 122 },
          { pp: 3, silksColor: '#B7891F', horse: 'Wind Flower', ml: '3-1', jockey: 'L. Mercado', trainer: 'M. Ortega', weight: 120 },
          { pp: 4, silksColor: '#1F3A6E', horse: 'Interceptor', ml: '4-1', jockey: 'F. Ramos', trainer: 'P. Lim', weight: 121 },
          { pp: 5, silksColor: '#8A1C2B', horse: 'Little Jamie', ml: '8-1', jockey: 'E. Bautista', trainer: 'C. Tan', weight: 118 }
        ]
      }
    ]
  }
];

export interface RaceResult {
  track: string;
  date: string;
  raceNo: number;
  distance: string;
  surface: string;
  finalTime: string;
  finishers: { pos: number; horse: string; jockey: string; margin: string; odds: string }[];
  payouts: { win: string; place: string; show: string };
  chartNote: string;
}

export const results: RaceResult[] = [
  {
    track: 'Naga Turf Club',
    date: '2026-09-13',
    raceNo: 5,
    distance: '1200m',
    surface: 'Turf',
    finalTime: '1:09.84',
    finishers: [
      { pos: 1, horse: 'Silver Comet', jockey: 'R. Villanueva', margin: '1¾', odds: '5-2' },
      { pos: 2, horse: 'Harbor Master', jockey: 'J. dela Cruz', margin: 'nk', odds: '7-2' },
      { pos: 3, horse: 'Crimson Ledger', jockey: 'D. Santos', margin: '2½', odds: '4-1' },
      { pos: 4, horse: 'Paper Lantern', jockey: 'F. Ramos', margin: '5', odds: '12-1' }
    ],
    payouts: { win: '$7.00', place: '$3.80', show: '$2.60' },
    chartNote: 'SILVER COMET stalked the pace three wide, took command at the head of the lane and drew clear under a hand ride.'
  },
  {
    track: 'Metro Downs',
    date: '2026-09-12',
    raceNo: 4,
    distance: '1400m',
    surface: 'Dirt',
    finalTime: '1:23.51',
    finishers: [
      { pos: 1, horse: 'Wind Flower', jockey: 'L. Mercado', margin: '¾', odds: '3-1' },
      { pos: 2, horse: 'Interceptor', jockey: 'F. Ramos', margin: '1¼', odds: '4-1' },
      { pos: 3, horse: 'Little Jamie', jockey: 'E. Bautista', margin: 'hd', odds: '8-1' },
      { pos: 4, horse: 'Napoleon Solo', jockey: 'R. Villanueva', margin: '3', odds: '7-2' }
    ],
    payouts: { win: '$8.20', place: '$4.40', show: '$3.20' },
    chartNote: 'WIND FLOWER settled off the dueling leaders, angled out entering the stretch and edged past late.'
  },
  {
    track: 'Naga Turf Club',
    date: '2026-09-08',
    raceNo: 3,
    distance: '1400m',
    surface: 'Turf',
    finalTime: '1:21.97',
    finishers: [
      { pos: 1, horse: 'Golden Tempo', jockey: 'L. Mercado', margin: '2¼', odds: '2-1' },
      { pos: 2, horse: 'Night Parade', jockey: 'D. Santos', margin: '1', odds: '5-2' },
      { pos: 3, horse: 'Renegade', jockey: 'R. Villanueva', margin: 'ns', odds: '3-1' },
      { pos: 4, horse: 'Magnitude', jockey: 'E. Bautista', margin: '4½', odds: '7-1' }
    ],
    payouts: { win: '$6.00', place: '$3.20', show: '$2.40' },
    chartNote: 'GOLDEN TEMPO broke sharply, set honest fractions and held sway. NIGHT PARADE rallied willingly for the place.'
  }
];

export interface Workout {
  date: string;
  horse: string;
  track: string;
  distance: string;
  time: string;
  note: string;
  rank: string;
}

export const workouts: Workout[] = [
  { date: '2026-09-16', horse: 'Silver Comet', track: 'Naga Turf Club', distance: '800m', time: '48.20', note: 'Breezing', rank: '2/31' },
  { date: '2026-09-16', horse: 'Golden Tempo', track: 'Naga Turf Club', distance: '1000m', time: '1:00.40', note: 'Handily', rank: '1/18' },
  { date: '2026-09-15', horse: 'Night Parade', track: 'Metro Downs', distance: '1000m', time: '1:01.80', note: 'Breezing', rank: '5/22' },
  { date: '2026-09-15', horse: 'Renegade', track: 'Metro Downs', distance: '800m', time: '47.90', note: 'Handily', rank: '1/27' },
  { date: '2026-09-14', horse: 'Bravado Star', track: 'Naga Turf Club', distance: '1200m', time: '1:14.60', note: 'Breezing', rank: '3/12' },
  { date: '2026-09-13', horse: 'Monsoon Lily', track: 'Naga Turf Club', distance: '600m', time: '36.40', note: 'Breezing', rank: '7/25' },
  { date: '2026-09-12', horse: 'Wind Flower', track: 'Metro Downs', distance: '800m', time: '48.80', note: 'Easily', rank: '6/30' },
  { date: '2026-09-11', horse: 'Skippylongstocking', track: 'Metro Downs', distance: '1000m', time: '1:00.90', note: 'Handily', rank: '2/16' },
  { date: '2026-09-10', horse: 'Counting Stars', track: 'Naga Turf Club', distance: '800m', time: '49.30', note: 'Breezing', rank: '9/28' },
  { date: '2026-09-09', horse: 'Interceptor', track: 'Metro Downs', distance: '600m', time: '35.90', note: 'Handily', rank: '1/21' },
  { date: '2026-09-08', horse: 'Iron Duke', track: 'Naga Turf Club', distance: '600m', time: '37.10', note: 'Easily (return from layoff)', rank: '14/25' },
  { date: '2026-09-07', horse: 'Knightsbridge', track: 'Metro Downs', distance: '1000m', time: '1:01.20', note: 'Breezing', rank: '4/19' }
];

export interface SpeedFigure {
  horse: string;
  figure: number;
  date: string;
  track: string;
  distance: string;
  finish: string;
}

export const speedFigures: SpeedFigure[] = [
  { horse: 'Golden Tempo', figure: 108, date: '2026-09-08', track: 'Naga Turf Club', distance: '1400m', finish: '1st' },
  { horse: 'Renegade', figure: 104, date: '2026-08-30', track: 'Metro Downs', distance: '1600m', finish: '1st' },
  { horse: 'Silver Comet', figure: 102, date: '2026-09-13', track: 'Naga Turf Club', distance: '1200m', finish: '1st' },
  { horse: 'Skippylongstocking', figure: 101, date: '2026-08-22', track: 'Metro Downs', distance: '1800m', finish: '2nd' },
  { horse: 'Wind Flower', figure: 99, date: '2026-09-12', track: 'Metro Downs', distance: '1400m', finish: '1st' },
  { horse: 'Napoleon Solo', figure: 97, date: '2026-08-15', track: 'Metro Downs', distance: '1800m', finish: '1st' },
  { horse: 'Night Parade', figure: 95, date: '2026-09-08', track: 'Naga Turf Club', distance: '1400m', finish: '2nd' },
  { horse: 'Counting Stars', figure: 94, date: '2026-08-28', track: 'Naga Turf Club', distance: '1600m', finish: '3rd' },
  { horse: 'Bravado Star', figure: 92, date: '2026-08-20', track: 'Naga Turf Club', distance: '1600m', finish: '1st' },
  { horse: 'Interceptor', figure: 91, date: '2026-09-12', track: 'Metro Downs', distance: '1400m', finish: '2nd' }
];

export interface StandingRow {
  name: string;
  starts: number;
  wins: number;
  places: number;
  shows: number;
  earningsUsd: number;
}

export const jockeyStandings: StandingRow[] = [
  { name: 'R. Villanueva', starts: 212, wins: 48, places: 39, shows: 31, earningsUsd: 2140500 },
  { name: 'L. Mercado', starts: 198, wins: 44, places: 35, shows: 28, earningsUsd: 1987200 },
  { name: 'D. Santos', starts: 224, wins: 41, places: 44, shows: 36, earningsUsd: 1856000 },
  { name: 'J. dela Cruz', starts: 176, wins: 32, places: 29, shows: 27, earningsUsd: 1322400 },
  { name: 'F. Ramos', starts: 168, wins: 27, places: 30, shows: 24, earningsUsd: 1104800 },
  { name: 'E. Bautista', starts: 190, wins: 25, places: 33, shows: 35, earningsUsd: 1078900 },
  { name: 'G. Flores', starts: 121, wins: 14, places: 18, shows: 20, earningsUsd: 512300 }
];

export const trainerStandings: StandingRow[] = [
  { name: 'C. Tan', starts: 164, wins: 42, places: 30, shows: 24, earningsUsd: 2455000 },
  { name: 'A. Reyes', starts: 149, wins: 36, places: 28, shows: 22, earningsUsd: 2019800 },
  { name: 'M. Ortega', starts: 132, wins: 31, places: 26, shows: 19, earningsUsd: 1877300 },
  { name: 'P. Lim', starts: 171, wins: 29, places: 34, shows: 30, earningsUsd: 1546100 },
  { name: 'B. Navarro', starts: 98, wins: 15, places: 17, shows: 16, earningsUsd: 622700 }
];

export interface StakesRace {
  date: string;
  race: string;
  grade: 'G1' | 'G2' | 'G3' | 'Listed';
  track: string;
  distance: string;
  surface: string;
  purse: string;
  conditions: string;
}

export const stakesSchedule: StakesRace[] = [
  { date: '2026-09-20', race: 'Provincial Cup Prep', grade: 'G3', track: 'Naga Turf Club', distance: '1600m', surface: 'Turf', purse: '$120,000', conditions: '3yo+' },
  { date: '2026-09-27', race: 'Metro Sprint Championship', grade: 'G2', track: 'Metro Downs', distance: '1200m', surface: 'Dirt', purse: '$250,000', conditions: '3yo+' },
  { date: '2026-10-04', race: 'Provincial Cup', grade: 'G1', track: 'Naga Turf Club', distance: '2000m', surface: 'Turf', purse: '$500,000', conditions: '3yo+' },
  { date: '2026-10-11', race: 'Juvenile Trial', grade: 'G3', track: 'Metro Downs', distance: '1400m', surface: 'Dirt', purse: '$150,000', conditions: '2yo' },
  { date: '2026-10-18', race: "Founders' Mile", grade: 'G2', track: 'Naga Turf Club', distance: '1600m', surface: 'Turf', purse: '$300,000', conditions: '3yo+' },
  { date: '2026-10-25', race: 'Harvest Handicap', grade: 'Listed', track: 'Metro Downs', distance: '1800m', surface: 'Dirt', purse: '$100,000', conditions: '3yo+' },
  { date: '2026-11-01', race: 'Fillies & Mares Classic', grade: 'G2', track: 'Naga Turf Club', distance: '1800m', surface: 'Turf', purse: '$275,000', conditions: 'F&M 3yo+' },
  { date: '2026-11-15', race: 'Champions Day Cup', grade: 'G1', track: 'Metro Downs', distance: '2000m', surface: 'Dirt', purse: '$750,000', conditions: '3yo+' },
  { date: '2026-11-29', race: 'Season Finale Sprint', grade: 'G3', track: 'Metro Downs', distance: '1000m', surface: 'Dirt', purse: '$140,000', conditions: '3yo+' }
];

export interface WatchItem {
  name: string;
  watched: boolean;
  lastActivity: string;
  nextAlert: string | null;
}

export const virtualStable: WatchItem[] = [
  { name: 'Silver Comet', watched: true, lastActivity: 'Won R5 at Naga Turf Club, Sep 13 (Fig 102)', nextAlert: 'Entered — R5 Naga Turf Club, Sep 20' },
  { name: 'Night Parade', watched: true, lastActivity: '2nd in R3 at Naga Turf Club, Sep 8', nextAlert: 'Entered — R3 Metro Downs, Sep 19' },
  { name: 'Bravado Star', watched: true, lastActivity: 'Worked 1200m in 1:14.60 (3/12), Sep 14', nextAlert: 'Entered — R6 Naga Turf Club, Sep 20' },
  { name: 'Golden Tempo', watched: false, lastActivity: 'Won R3 at Naga Turf Club, Sep 8 (Fig 108)', nextAlert: 'Entered — R5 Naga Turf Club, Sep 20' },
  { name: 'Renegade', watched: false, lastActivity: 'Worked 800m in 47.90 (1/27), Sep 15', nextAlert: 'Entered — R6 Naga Turf Club, Sep 20' },
  { name: 'Monsoon Lily', watched: true, lastActivity: 'Worked 600m in 36.40 (7/25), Sep 13', nextAlert: null },
  { name: 'Iron Duke', watched: true, lastActivity: 'Returned to work: 600m easily, Sep 8', nextAlert: null },
  { name: 'Wind Flower', watched: false, lastActivity: 'Won R4 at Metro Downs, Sep 12 (Fig 99)', nextAlert: null }
];
